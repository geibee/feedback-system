package postgres

import (
	"context"
	"fmt"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/export"
)

type evidenceExportQuery struct {
	Path   string
	Header []string
	SQL    string
}

func (d *Database) prepareEvidencePackageExport(
	ctx context.Context,
	claimed export.Claimed,
) (export.Prepared, error) {
	var prepared export.Prepared
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if _, err := tx.Exec(txCtx, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`); err != nil {
			return fmt.Errorf("証跡exportのsnapshot isolationを設定できません: %w", err)
		}
		var tenantKey, applicationKey, environmentKey, workspaceKey string
		var sessionID *string
		if err := tx.QueryRow(txCtx, `SELECT tenant.tenant_key, application.application_key,
       environment.environment_key, workspace.external_workspace_key, job.session_id::text,
       COALESCE(policy.export_retention_days, 7)
FROM feedback.export_jobs job
JOIN feedback.tenants tenant ON tenant.id = job.tenant_id
JOIN feedback.applications application ON application.id = job.application_id
JOIN feedback.application_environments environment ON environment.id = job.environment_id
JOIN feedback.workspaces workspace ON workspace.id = job.workspace_id
LEFT JOIN feedback.retention_policies policy ON policy.workspace_id = job.workspace_id
WHERE job.id = $1::uuid`, claimed.ID).Scan(
			&tenantKey, &applicationKey, &environmentKey, &workspaceKey, &sessionID, &prepared.RetentionDays,
		); err != nil {
			return fmt.Errorf("証跡export metadataを取得できません: %w", err)
		}

		entries := make([]export.CSVEntry, 0, len(evidencePackageExportQueries())+1)
		for _, query := range evidencePackageExportQueries() {
			rows, err := queryBackupRows(txCtx, tx, query.SQL, claimed.ID)
			if err != nil {
				return fmt.Errorf("%sを証跡export用に取得できません: %w", query.Path, err)
			}
			entries = append(entries, export.CSVEntry{Path: query.Path, Header: query.Header, Rows: rows})
		}
		evidenceCSV, evidenceEntries, err := prepareEvidencePackageFiles(txCtx, tx, claimed.ID)
		if err != nil {
			return err
		}
		entries = append(entries, evidenceCSV)
		prepared.EvidencePackage = &export.EvidencePackage{
			ExportID: claimed.ID, TenantKey: tenantKey, ApplicationKey: applicationKey,
			EnvironmentKey: environmentKey, ExternalWorkspaceKey: workspaceKey, SessionID: sessionID,
			CSVEntries: entries, EvidenceEntries: evidenceEntries,
		}
		return nil
	})
	return prepared, err
}

func evidencePackageExportQueries() []evidenceExportQuery {
	return []evidenceExportQuery{
		{
			Path:   "data/sessions.csv",
			Header: []string{"session_id", "manifest_version", "title", "description", "status", "out_of_scope_posting", "start_at", "end_at", "version", "created_at", "updated_at"},
			SQL: `SELECT session.id::text, session.manifest_version, session.title, session.description,
session.status, session.out_of_scope_posting, session.start_at::text, session.end_at::text,
session.version::text, session.created_at::text, session.updated_at::text
FROM feedback.export_jobs job
JOIN feedback.review_sessions session ON session.workspace_id = job.workspace_id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR session.id = job.session_id)
ORDER BY session.created_at, session.id`,
		},
		{
			Path:   "data/session_scopes.csv",
			Header: []string{"scope_id", "session_id", "page_key", "route_template", "reviewable"},
			SQL: `SELECT scope.id::text, scope.session_id::text, scope.page_key, scope.route_template, scope.reviewable::text
FROM feedback.export_jobs job
JOIN feedback.review_sessions session ON session.workspace_id = job.workspace_id
JOIN feedback.review_scopes scope ON scope.session_id = session.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR session.id = job.session_id)
ORDER BY session.created_at, scope.page_key, scope.id`,
		},
		{
			Path:   "data/session_scope_perspectives.csv",
			Header: []string{"scope_id", "session_id", "perspective_code"},
			SQL: `SELECT scope.id::text, scope.session_id::text, perspective.code
FROM feedback.export_jobs job
JOIN feedback.review_sessions session ON session.workspace_id = job.workspace_id
JOIN feedback.review_scopes scope ON scope.session_id = session.id
CROSS JOIN LATERAL unnest(scope.perspective_codes) perspective(code)
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR session.id = job.session_id)
ORDER BY session.created_at, scope.id, perspective.code`,
		},
		{
			Path:   "data/session_perspectives.csv",
			Header: []string{"session_id", "code", "label", "status", "guidance"},
			SQL: `SELECT perspective.session_id::text, perspective.code, perspective.label, perspective.status, perspective.guidance
FROM feedback.export_jobs job
JOIN feedback.review_sessions session ON session.workspace_id = job.workspace_id
JOIN feedback.review_session_perspectives perspective ON perspective.session_id = session.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR session.id = job.session_id)
ORDER BY session.created_at, perspective.code`,
		},
		{
			Path:   "data/threads.csv",
			Header: []string{"thread_id", "session_id", "display_number", "status", "perspective_code", "location_json", "target_json", "reporter_principal_id", "reporter_display_name", "reporter_participant_name", "assignee_user_id", "assignee_display_name", "priority", "version", "created_at", "updated_at"},
			SQL: `SELECT thread.id::text, thread.session_id::text, thread.display_number::text,
thread.status, thread.perspective_code, thread.location::text, thread.target::text,
thread.reporter_principal_id, thread.reporter_display_name, thread.reporter_participant_name,
thread.assignee_user_id::text, COALESCE(assignee.display_name, assignee.email, assignee.subject),
thread.priority, thread.version::text, thread.created_at::text, thread.updated_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
LEFT JOIN feedback.users assignee ON assignee.id = thread.assignee_user_id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY thread.created_at, thread.id`,
		},
		{
			Path:   "data/thread_labels.csv",
			Header: []string{"thread_id", "label"},
			SQL: `SELECT thread.id::text, label.value
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
CROSS JOIN LATERAL unnest(thread.labels) label(value)
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY thread.created_at, thread.id, label.value`,
		},
		{
			Path:   "data/messages.csv",
			Header: []string{"message_id", "thread_id", "author_principal_id", "author_display_name", "author_participant_name", "body", "version", "created_at", "edited_at"},
			SQL: `SELECT message.id::text, message.thread_id::text, message.author_principal_id,
message.author_display_name, message.author_participant_name, message.body, message.version::text,
message.created_at::text, message.edited_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.feedback_messages message ON message.thread_id = thread.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY message.created_at, message.id`,
		},
		{
			Path:   "data/message_versions.csv",
			Header: []string{"message_id", "thread_id", "version", "current", "author_principal_id", "author_display_name", "author_participant_name", "body", "created_at", "edited_at"},
			SQL: `SELECT version.message_id::text, version.thread_id::text, version.version::text, 'false',
version.author_principal_id, version.author_display_name, version.author_participant_name, version.body,
version.created_at::text, version.edited_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.feedback_message_versions version ON version.thread_id = thread.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
UNION ALL
SELECT message.id::text, message.thread_id::text, message.version::text, 'true',
message.author_principal_id, message.author_display_name, message.author_participant_name, message.body,
message.created_at::text, message.edited_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.feedback_messages message ON message.thread_id = thread.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY 2, 1, 3`,
		},
		{
			Path:   "data/status_events.csv",
			Header: []string{"sequence", "thread_id", "event_type", "status", "occurred_at"},
			SQL: `SELECT journal.sequence::text, thread.id::text, journal.event_type,
CASE journal.event_type WHEN 'feedback.thread.resolved.v1' THEN 'resolved' ELSE 'open' END,
journal.occurred_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.feedback_change_journal journal ON journal.workspace_id = thread.workspace_id
  AND journal.resource_type = 'thread' AND journal.resource_id = thread.id::text
  AND journal.event_type IN ('feedback.thread.created.v1', 'feedback.thread.resolved.v1', 'feedback.thread.reopened.v1')
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY journal.sequence`,
		},
		{
			Path:   "data/triage_events.csv",
			Header: []string{"event_id", "thread_id", "actor_user_id", "assignee_user_id", "priority", "labels_json", "occurred_at"},
			SQL: `SELECT event.id::text, event.thread_id::text, event.actor_user_id::text,
event.assignee_user_id::text, event.priority, array_to_json(event.labels)::text, event.occurred_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.thread_triage_events event ON event.thread_id = thread.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY event.occurred_at, event.id`,
		},
		{
			Path:   "data/reactions.csv",
			Header: []string{"message_id", "thread_id", "user_id", "reaction", "created_at"},
			SQL: `SELECT reaction.message_id::text, thread.id::text, reaction.user_id::text,
reaction.reaction, reaction.created_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.feedback_messages message ON message.thread_id = thread.id
JOIN feedback.message_reactions reaction ON reaction.message_id = message.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY reaction.created_at, reaction.message_id, reaction.user_id, reaction.reaction`,
		},
		{
			Path:   "data/reaction_events.csv",
			Header: []string{"event_id", "thread_id", "message_id", "user_id", "reaction", "action", "occurred_at"},
			SQL: `SELECT event.id::text, event.thread_id::text, event.message_id::text,
event.user_id::text, event.reaction, event.action, event.occurred_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.reaction_events event ON event.thread_id = thread.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY event.occurred_at, event.id`,
		},
	}
}

func prepareEvidencePackageFiles(
	ctx context.Context,
	queryer sessionQueryer,
	exportID string,
) (export.CSVEntry, []export.EvidenceEntry, error) {
	rows, err := queryBackupRows(ctx, queryer, `SELECT evidence.id::text, evidence.thread_id::text,
evidence.object_key, evidence.content_type, evidence.byte_size::text, evidence.sha256,
evidence.viewport_width::text, evidence.viewport_height::text, evidence.pixel_ratio::text,
evidence.captured_at::text, evidence.created_at::text
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
JOIN feedback.review_evidence evidence ON evidence.thread_id = thread.id
WHERE job.id = $1::uuid AND (job.session_id IS NULL OR thread.session_id = job.session_id)
ORDER BY evidence.created_at, evidence.id`, exportID)
	if err != nil {
		return export.CSVEntry{}, nil, fmt.Errorf("evidence.csvを証跡export用に取得できません: %w", err)
	}
	csvRows := make([][]*string, 0, len(rows))
	files := make([]export.EvidenceEntry, 0, len(rows))
	for _, row := range rows {
		extension := "png"
		if stringValue(row[3]) == "image/webp" {
			extension = "webp"
		}
		archivePath := "evidence/" + stringValue(row[1]) + "/" + stringValue(row[0]) + "." + extension
		csvRows = append(csvRows, []*string{
			row[0], row[1], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], stringPointer(archivePath),
		})
		files = append(files, export.EvidenceEntry{
			ArchivePath: archivePath, ObjectKey: stringValue(row[2]), ExpectedSHA256: stringValue(row[5]),
		})
	}
	return export.CSVEntry{
		Path:   "data/evidence.csv",
		Header: []string{"evidence_id", "thread_id", "content_type", "byte_size", "sha256", "viewport_width", "viewport_height", "pixel_ratio", "captured_at", "created_at", "archive_path"},
		Rows:   csvRows,
	}, files, nil
}
