package postgres

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/usecase"
)

// ResolvePrincipal は検証済みissuer/subjectを既存userへ冪等に対応付ける。
func (d *Database) ResolvePrincipal(ctx context.Context, identity auth.Identity) (auth.Principal, error) {
	var userID string
	err := d.QueryRow(ctx, `INSERT INTO feedback.users (id, issuer, subject, email, display_name)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (issuer, subject) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now()
RETURNING id::text`,
		uuid.NewString(), identity.Issuer, identity.Subject, identity.Email, identity.DisplayName,
	).Scan(&userID)
	if err != nil {
		return auth.Principal{}, fmt.Errorf("principalを解決できません: %w", err)
	}
	return auth.Principal{
		UserID: userID, Issuer: identity.Issuer, Subject: identity.Subject,
		Email: identity.Email, DisplayName: identity.DisplayName, TokenScope: identity.TokenScope,
	}, nil
}

func (d *Database) ListMemberships(ctx context.Context, userID string) ([]auth.Membership, error) {
	rows, err := d.Query(ctx, `SELECT a.application_key, w.external_workspace_key, wm.permissions
FROM feedback.workspace_memberships wm
JOIN feedback.workspaces w ON w.id = wm.workspace_id
JOIN feedback.applications a ON a.id = w.application_id
WHERE wm.user_id = $1::uuid
ORDER BY a.application_key, w.external_workspace_key`, userID)
	if err != nil {
		return nil, fmt.Errorf("membershipを取得できません: %w", err)
	}
	defer rows.Close()

	result := make([]auth.Membership, 0)
	for rows.Next() {
		var applicationKey, workspaceKey string
		var values []string
		if err := rows.Scan(&applicationKey, &workspaceKey, &values); err != nil {
			return nil, fmt.Errorf("membershipを読み取れません: %w", err)
		}
		permissions, err := permissionsFromDatabase(values)
		if err != nil {
			return nil, err
		}
		result = append(result, auth.Membership{
			ApplicationKey: applicationKey, ExternalWorkspaceKey: workspaceKey, Permissions: permissions,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("membershipの走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) ApplicationPermissions(
	ctx context.Context,
	userID string,
	applicationID string,
) ([]auth.Permission, error) {
	return d.permissionQuery(
		ctx,
		`SELECT permissions FROM feedback.application_memberships WHERE user_id = $1::uuid AND application_id = $2::uuid`,
		userID,
		applicationID,
	)
}

func (d *Database) WorkspacePermissions(
	ctx context.Context,
	userID string,
	workspaceID string,
) ([]auth.Permission, error) {
	return d.permissionQuery(
		ctx,
		`SELECT permissions FROM feedback.workspace_memberships WHERE user_id = $1::uuid AND workspace_id = $2::uuid`,
		userID,
		workspaceID,
	)
}

func (d *Database) permissionQuery(ctx context.Context, sql, userID, resourceID string) ([]auth.Permission, error) {
	var values []string
	if err := d.QueryRow(ctx, sql, userID, resourceID).Scan(&values); err != nil {
		if err == pgx.ErrNoRows {
			return []auth.Permission{}, nil
		}
		return nil, fmt.Errorf("permissionを取得できません: %w", err)
	}
	return permissionsFromDatabase(values)
}

func permissionsFromDatabase(values []string) ([]auth.Permission, error) {
	result := make([]auth.Permission, 0, len(values))
	for _, value := range values {
		permission := auth.Permission(value)
		if !auth.IsValidPermission(permission) {
			return nil, fmt.Errorf("DBに不明なfeedback permissionがあります: %q", value)
		}
		result = append(result, permission)
	}
	return result, nil
}

func (d *Database) IsIssuerAllowed(
	ctx context.Context,
	scope auth.ResourceScope,
	issuer string,
	applicationOnly bool,
) (bool, error) {
	issuer = strings.TrimRight(issuer, "/")
	var allowed bool
	var err error
	if !applicationOnly && scope.EnvironmentID != "" {
		err = d.QueryRow(
			ctx,
			`SELECT $1 = ANY(allowed_issuers) FROM feedback.application_environments WHERE id = $2::uuid`,
			issuer,
			scope.EnvironmentID,
		).Scan(&allowed)
	} else {
		err = d.QueryRow(
			ctx,
			`SELECT coalesce(bool_or($1 = ANY(allowed_issuers)), false)
FROM feedback.application_environments WHERE application_id = $2::uuid`,
			issuer,
			scope.ApplicationID,
		).Scan(&allowed)
	}
	if err != nil {
		return false, fmt.Errorf("issuer allowlistを取得できません: %w", err)
	}
	return allowed, nil
}

// RecordDenial は401/403の応答前に拒否監査を永続化する。
func (d *Database) RecordDenial(ctx context.Context, event auth.DenialEvent) error {
	action := event.Action
	if event.Kind == auth.DenialAuthentication {
		action = "authenticate"
	}
	return d.RecordAudit(ctx, usecase.AuditEvent{
		Scope: event.Scope, PrincipalID: event.PrincipalID, Action: action,
		ResourceType: event.ResourceType, ResourceID: event.ResourceID,
		Outcome: "denied", RequestID: event.RequestID,
	})
}

func nullableUUID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}
