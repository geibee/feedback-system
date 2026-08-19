// Package export はfeedback exportのAPI/worker業務境界を提供する。
package export

import (
	"errors"
	"io"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
)

const (
	FormatCSV             = "csv"
	FormatXLSX            = "xlsx"
	FormatEvidencePackage = "evidence-package"
)

var (
	ErrInvalid            = errors.New("export requestが不正です")
	ErrStorageUnavailable = errors.New("export storageを利用できません")
)

type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string { return err.Detail }
func (err *Error) Unwrap() error { return err.Kind }

type Request struct {
	ApplicationKey       string  `json:"applicationKey"`
	EnvironmentKey       string  `json:"environmentKey"`
	ExternalWorkspaceKey string  `json:"externalWorkspaceKey"`
	SessionID            *string `json:"sessionId"`
	Format               string  `json:"format"`
	Locale               string  `json:"locale"`
	Timezone             string  `json:"timezone"`
}

type CreateCommand struct {
	Request        Request
	IdempotencyKey string
	RequestHash    string
	RequestID      string
}

type Job struct {
	ID          string  `json:"id"`
	Status      string  `json:"status"`
	DownloadURL *string `json:"downloadUrl"`
	ExpiresAt   *string `json:"expiresAt"`
	CreatedAt   string  `json:"createdAt"`
	Error       *string `json:"error"`
}

type MutationResult struct {
	Job   Job
	Scope auth.ResourceScope
}

type Row struct {
	ThreadID          string
	DisplayNumber     int
	SessionID         string
	Status            string
	PerspectiveCode   string
	PageKey           string
	RouteTemplate     string
	TargetKind        string
	ReporterName      string
	MessageCount      int
	LatestMessage     string
	DeepLink          string
	EvidenceAvailable bool
	CreatedAt         string
	UpdatedAt         string
}

type Claimed struct {
	ID          string
	TenantID    string
	WorkspaceID string
	Format      string
	Locale      string
	Timezone    string
	ClaimToken  string
}

type Prepared struct {
	Rows            []Row
	RetentionDays   int
	EvidencePackage *EvidencePackage
}

type CSVEntry struct {
	Path   string
	Header []string
	Rows   [][]*string
}

type EvidenceEntry struct {
	ArchivePath    string
	ObjectKey      string
	ExpectedSHA256 string
}

type EvidencePackage struct {
	ExportID             string
	TenantKey            string
	ApplicationKey       string
	EnvironmentKey       string
	ExternalWorkspaceKey string
	SessionID            *string
	CSVEntries           []CSVEntry
	EvidenceEntries      []EvidenceEntry
}

type StoredMetadata struct {
	ObjectKey string
	Format    string
}

type Stored struct {
	FileName    string
	ContentType string
	Size        int64
	Body        io.ReadCloser
}
