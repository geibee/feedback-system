// Package bootstrap は初期tenant/application/workspace/membershipを冪等に登録する。
package bootstrap

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/postgres"
)

// Permission はauth packageの固定v1 permissionを利用する。
type Permission = auth.Permission

const (
	PermissionRead    = auth.PermissionRead
	PermissionComment = auth.PermissionComment
	PermissionManage  = auth.PermissionManage
	PermissionAdmin   = auth.PermissionAdmin
)

// ErrApplicationKeyConflict はapplication keyが別tenantで利用済みの場合に返す。
var ErrApplicationKeyConflict = errors.New("application keyは別tenantで使用済みです")

// Input は冪等bootstrapの入力である。
type Input struct {
	TenantKey              string       `json:"tenantKey"`
	TenantDisplayName      string       `json:"tenantDisplayName"`
	ApplicationKey         string       `json:"applicationKey"`
	ApplicationDisplayName string       `json:"applicationDisplayName"`
	EnvironmentKey         string       `json:"environmentKey"`
	EnvironmentBaseURL     string       `json:"environmentBaseUrl"`
	AllowedOrigins         []string     `json:"allowedOrigins"`
	ExternalWorkspaceKey   string       `json:"externalWorkspaceKey"`
	WorkspaceDisplayName   string       `json:"workspaceDisplayName"`
	Issuer                 string       `json:"issuer"`
	Subject                string       `json:"subject"`
	Email                  *string      `json:"email,omitempty"`
	DisplayName            *string      `json:"displayName,omitempty"`
	Permissions            []Permission `json:"permissions"`
}

// Result は登録または再利用したresource IDを返す。
type Result struct {
	TenantID      string
	ApplicationID string
	EnvironmentID string
	WorkspaceID   string
	PrincipalID   string
}

// Runner はbootstrapのtransaction境界を所有する。
type Runner struct {
	database postgres.Transactor
}

// NewRunner はbootstrap runnerを生成する。
func NewRunner(value postgres.Transactor) (*Runner, error) {
	if value == nil {
		return nil, errors.New("bootstrap databaseが未設定です")
	}
	return &Runner{database: value}, nil
}

// Run は全resourceを同じtransaction内で冪等upsertする。
func (r *Runner) Run(ctx context.Context, input Input) (Result, error) {
	validated, err := validateInput(input)
	if err != nil {
		return Result{}, err
	}

	var result Result
	err = r.database.InTransaction(ctx, func(txCtx context.Context, tx postgres.Tx) error {
		result, err = provision(txCtx, tx, validated)
		return err
	})
	if err != nil {
		return Result{}, err
	}
	return result, nil
}

// Apply は宣言文書の全entryを検証後、同じtransaction内で冪等に同期する。
func (r *Runner) Apply(ctx context.Context, document Document) ([]Result, error) {
	validated, err := validateDocument(document)
	if err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(validated))
	err = r.database.InTransaction(ctx, func(txCtx context.Context, tx postgres.Tx) error {
		for index, input := range validated {
			result, provisionErr := provision(txCtx, tx, input)
			if provisionErr != nil {
				return fmt.Errorf("entries[%d]を登録できません: %w", index, provisionErr)
			}
			results = append(results, result)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

func provision(ctx context.Context, tx postgres.Tx, input validatedInput) (Result, error) {
	tenantID, err := queryID(
		ctx,
		tx,
		tenantUpsertSQL,
		uuid.NewString(),
		input.tenantKey,
		input.tenantDisplayName,
	)
	if err != nil {
		return Result{}, fmt.Errorf("tenantを登録できません: %w", err)
	}

	applicationID, err := queryID(
		ctx,
		tx,
		applicationUpsertSQL,
		uuid.NewString(),
		tenantID,
		input.applicationKey,
		input.applicationDisplayName,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrApplicationKeyConflict
	}
	if err != nil {
		return Result{}, fmt.Errorf("applicationを登録できません: %w", err)
	}
	if err := lockApplicationMemberships(ctx, tx, applicationID); err != nil {
		return Result{}, err
	}

	environmentID, err := queryID(
		ctx,
		tx,
		environmentUpsertSQL,
		uuid.NewString(),
		applicationID,
		input.environmentKey,
		input.environmentBaseURL,
		input.allowedOrigins,
		input.issuer,
	)
	if err != nil {
		return Result{}, fmt.Errorf("application environmentを登録できません: %w", err)
	}

	workspaceID, err := queryID(
		ctx,
		tx,
		workspaceUpsertSQL,
		uuid.NewString(),
		tenantID,
		applicationID,
		input.externalWorkspaceKey,
		input.workspaceDisplayName,
	)
	if err != nil {
		return Result{}, fmt.Errorf("workspaceを登録できません: %w", err)
	}

	principalID, err := queryID(
		ctx,
		tx,
		principalUpsertSQL,
		uuid.NewString(),
		input.issuer,
		input.subject,
		nullableString(input.email),
		nullableString(input.displayName),
	)
	if err != nil {
		return Result{}, fmt.Errorf("principalを登録できません: %w", err)
	}

	if err := execAtMostOne(
		ctx,
		tx,
		workspaceMembershipUpsertSQL,
		workspaceID,
		principalID,
		input.permissions,
	); err != nil {
		return Result{}, fmt.Errorf("workspace membershipを登録できません: %w", err)
	}
	if err := postgres.SyncApplicationMembership(ctx, tx, applicationID, principalID); err != nil {
		return Result{}, err
	}

	return Result{
		TenantID:      tenantID,
		ApplicationID: applicationID,
		EnvironmentID: environmentID,
		WorkspaceID:   workspaceID,
		PrincipalID:   principalID,
	}, nil
}

func lockApplicationMemberships(ctx context.Context, tx postgres.Tx, applicationID string) error {
	var lockedID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM feedback.applications
WHERE id = $1::uuid
FOR UPDATE`, applicationID).Scan(&lockedID); err != nil {
		return fmt.Errorf("application membership変更lockを取得できません: %w", err)
	}
	return nil
}

func queryID(ctx context.Context, tx postgres.Tx, sql string, args ...any) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

func execAtMostOne(ctx context.Context, tx postgres.Tx, sql string, args ...any) error {
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 1 {
		return fmt.Errorf("更新件数が1を超えています: %d", tag.RowsAffected())
	}
	return nil
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

const tenantUpsertSQL = `INSERT INTO feedback.tenants (id, tenant_key, display_name)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_key) DO UPDATE SET display_name = EXCLUDED.display_name
RETURNING id::text`

const applicationUpsertSQL = `INSERT INTO feedback.applications (id, tenant_id, application_key, display_name)
VALUES ($1::uuid, $2::uuid, $3, $4)
ON CONFLICT (application_key) DO UPDATE SET display_name = EXCLUDED.display_name
WHERE feedback.applications.tenant_id = EXCLUDED.tenant_id
RETURNING id::text`

const environmentUpsertSQL = `INSERT INTO feedback.application_environments (
    id, application_id, environment_key, base_url, allowed_origins, allowed_issuers
) VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], ARRAY[$6]::text[])
ON CONFLICT (application_id, environment_key) DO UPDATE SET
    base_url = EXCLUDED.base_url,
    allowed_origins = EXCLUDED.allowed_origins,
    allowed_issuers = (
        SELECT array_agg(DISTINCT value ORDER BY value)
        FROM unnest(feedback.application_environments.allowed_issuers || EXCLUDED.allowed_issuers) value
    )
RETURNING id::text`

const workspaceUpsertSQL = `INSERT INTO feedback.workspaces (
    id, tenant_id, application_id, external_workspace_key, display_name
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
ON CONFLICT (application_id, external_workspace_key) DO UPDATE SET display_name = EXCLUDED.display_name
RETURNING id::text`

const principalUpsertSQL = `INSERT INTO feedback.users (id, issuer, subject, email, display_name)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (issuer, subject) DO UPDATE SET
    email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
RETURNING id::text`

const workspaceMembershipUpsertSQL = `INSERT INTO feedback.workspace_memberships (
    workspace_id, user_id, permissions
) VALUES ($1::uuid, $2::uuid, $3::text[])
ON CONFLICT (workspace_id, user_id) DO UPDATE SET
    permissions = EXCLUDED.permissions,
    version = feedback.workspace_memberships.version + 1,
    updated_at = now()
WHERE feedback.workspace_memberships.permissions IS DISTINCT FROM EXCLUDED.permissions`
