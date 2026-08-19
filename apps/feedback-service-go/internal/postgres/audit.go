package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/usecase"
)

type auditExecuter interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// RecordAudit は独立した監査（認可・拒否・read等）を記録する。
// 業務更新の成功監査は、更新transactionからinsertAuditを呼び出す。
func (d *Database) RecordAudit(ctx context.Context, event usecase.AuditEvent) error {
	return insertAudit(ctx, d, event)
}

// insertAudit は呼出側が所有するquery実行先へ監査を追加する。
// Txを渡した場合、監査INSERT失敗を業務更新と同じrollback境界へ伝播できる。
func insertAudit(ctx context.Context, executer auditExecuter, event usecase.AuditEvent) error {
	if executer == nil {
		return fmt.Errorf("audit query実行先が未設定です")
	}
	var tenantID, applicationID, workspaceID any
	if event.Scope != nil {
		tenantID = nullableUUID(event.Scope.TenantID)
		applicationID = nullableUUID(event.Scope.ApplicationID)
		workspaceID = nullableUUID(event.Scope.WorkspaceID)
	}
	var changes any
	if len(event.Changes) != 0 {
		if !json.Valid(event.Changes) {
			return fmt.Errorf("audit changes JSONが不正です")
		}
		changes = string(event.Changes)
	}
	_, err := executer.Exec(ctx, `INSERT INTO feedback.audit_logs (
    id, tenant_id, application_id, workspace_id, principal_id, action,
    resource_type, resource_id, outcome, request_id, changes
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
		uuid.NewString(), tenantID, applicationID, workspaceID,
		nullableText(event.PrincipalID), event.Action, nullableText(event.ResourceType), nullableText(event.ResourceID),
		event.Outcome, event.RequestID, changes,
	)
	if err != nil {
		return fmt.Errorf("audit logを記録できません: %w", err)
	}
	return nil
}
