package bootstrap

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestDecodeDocumentAndApplyAllEntriesInOneTransaction(t *testing.T) {
	t.Parallel()

	document, err := DecodeDocument(strings.NewReader(`{
  "schemaVersion": "1",
  "entries": [
    {
      "tenantKey": "company",
      "tenantDisplayName": "Company",
      "applicationKey": "portal",
      "applicationDisplayName": "Portal",
      "environmentKey": "production",
      "environmentBaseUrl": "https://portal.example.test",
      "allowedOrigins": ["https://portal.example.test"],
      "externalWorkspaceKey": "sales",
      "workspaceDisplayName": "Sales",
      "issuer": "https://id.example.test",
      "subject": "owner",
      "permissions": ["feedback.read", "feedback.admin"]
    },
    {
      "tenantKey": "company",
      "tenantDisplayName": "Company",
      "applicationKey": "portal",
      "applicationDisplayName": "Portal",
      "environmentKey": "production",
      "environmentBaseUrl": "https://portal.example.test",
      "allowedOrigins": ["https://portal.example.test"],
      "externalWorkspaceKey": "engineering",
      "workspaceDisplayName": "Engineering",
      "issuer": "https://id.example.test",
      "subject": "reviewer",
      "permissions": ["feedback.read", "feedback.comment"]
    }
  ]
}`))
	if err != nil {
		t.Fatalf("DecodeDocument() error = %v", err)
	}

	rows := make([]pgx.Row, 0, 10)
	for index := 0; index < 2; index++ {
		rows = append(rows,
			staticRow{value: "tenant-id"},
			staticRow{value: "application-id"},
			staticRow{value: "environment-id"},
			staticRow{value: "workspace-id"},
			staticRow{value: "principal-id"},
		)
	}
	transactor := &recordingTransactor{tx: &recordingTx{rows: rows}}
	runner, err := NewRunner(transactor)
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	results, err := runner.Apply(context.Background(), document)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(results) != 2 || transactor.calls.Load() != 1 {
		t.Fatalf("results=%d transactions=%d", len(results), transactor.calls.Load())
	}
}

func TestDecodeDocumentRejectsUnknownFieldAndTrailingJSON(t *testing.T) {
	t.Parallel()

	for name, value := range map[string]string{
		"unknown":  `{"schemaVersion":"1","entries":[],"secret":"value"}`,
		"trailing": `{"schemaVersion":"1","entries":[]} {}`,
	} {
		name, value := name, value
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := DecodeDocument(strings.NewReader(value)); err == nil {
				t.Fatal("不正なinstallation manifestが受理されました")
			}
		})
	}
}

func TestDecodeDocumentRejectsApplicationKeyAcrossTenants(t *testing.T) {
	t.Parallel()

	first := validInput()
	second := validInput()
	second.TenantKey = "another-tenant"
	second.TenantDisplayName = "Another tenant"
	_, err := validateDocument(Document{SchemaVersion: "1", Entries: []Input{first, second}})
	if err == nil || !strings.Contains(err.Error(), "Service全体で一意") {
		t.Fatalf("validateDocument() error = %v", err)
	}
}

func TestValidateDocumentRejectsConflictingSharedResource(t *testing.T) {
	t.Parallel()

	first := validInput()
	second := validInput()
	second.Subject = "another-user"
	second.EnvironmentBaseURL = "https://another.example.test"
	_, err := validateDocument(Document{SchemaVersion: "1", Entries: []Input{first, second}})
	if err == nil || !strings.Contains(err.Error(), "environment定義") {
		t.Fatalf("validateDocument() error = %v", err)
	}
}

func TestValidateDocumentRejectsOrderDependentApplicationMembership(t *testing.T) {
	t.Parallel()

	first := validInput()
	second := validInput()
	second.ExternalWorkspaceKey = "another-workspace"
	second.WorkspaceDisplayName = "Another workspace"
	second.Permissions = []Permission{PermissionRead}
	_, err := validateDocument(Document{SchemaVersion: "1", Entries: []Input{first, second}})
	if err == nil || !strings.Contains(err.Error(), "application membership") {
		t.Fatalf("validateDocument() error = %v", err)
	}
}

func TestApplyValidatesEveryEntryBeforeTransaction(t *testing.T) {
	t.Parallel()

	valid := validInput()
	invalid := validInput()
	invalid.Subject = ""
	transactor := &recordingTransactor{tx: &recordingTx{}}
	runner, err := NewRunner(transactor)
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	_, err = runner.Apply(context.Background(), Document{
		SchemaVersion: "1",
		Entries:       []Input{valid, invalid},
	})
	if err == nil {
		t.Fatal("不正entryが受理されました")
	}
	if transactor.calls.Load() != 0 {
		t.Fatal("全entryの検証前にtransactionが開始されました")
	}
}
