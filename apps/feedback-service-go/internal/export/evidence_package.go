package export

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/backup"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/objectstore"
)

type evidencePackageFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Rows   *int64 `json:"rows,omitempty"`
}

type evidencePackageManifest struct {
	SchemaVersion        string                `json:"schemaVersion"`
	ExportID             string                `json:"exportId"`
	GeneratedAt          string                `json:"generatedAt"`
	TenantKey            string                `json:"tenantKey"`
	ApplicationKey       string                `json:"applicationKey"`
	EnvironmentKey       string                `json:"environmentKey"`
	ExternalWorkspaceKey string                `json:"externalWorkspaceKey"`
	SessionID            *string               `json:"sessionId"`
	Files                []evidencePackageFile `json:"files"`
}

// WriteEvidencePackage は正規化CSV、証跡画像、検証用manifestを単一ZIPへ書き出す。
func WriteEvidencePackage(
	ctx context.Context,
	prepared EvidencePackage,
	evidenceStorage objectstore.Store,
	target string,
	generatedAt time.Time,
) (int64, error) {
	if evidenceStorage == nil || target == "" {
		return 0, errors.New("evidence package dependencyが未設定です")
	}
	file, err := os.Create(target)
	if err != nil {
		return 0, fmt.Errorf("evidence packageを作成できません: %w", err)
	}
	complete := false
	defer func() {
		_ = file.Close()
		if !complete {
			_ = os.Remove(target)
		}
	}()

	archive := zip.NewWriter(file)
	files := make([]evidencePackageFile, 0, len(prepared.CSVEntries)+len(prepared.EvidenceEntries))
	for _, entry := range prepared.CSVEntries {
		if err := validateEvidencePackagePath(entry.Path); err != nil {
			return 0, err
		}
		data := backup.RenderArchiveCSV(entry.Header, entry.Rows)
		if err := writeEvidencePackageBytes(archive, entry.Path, data); err != nil {
			return 0, err
		}
		rows := int64(len(entry.Rows))
		files = append(files, evidencePackageFile{
			Path: entry.Path, SHA256: sha256Hex(data), Bytes: int64(len(data)), Rows: &rows,
		})
	}
	for _, entry := range prepared.EvidenceEntries {
		if err := validateEvidencePackagePath(entry.ArchivePath); err != nil {
			return 0, err
		}
		object, err := evidenceStorage.Get(ctx, entry.ObjectKey)
		if err != nil {
			return 0, fmt.Errorf("証跡画像を取得できません: %w", err)
		}
		writer, err := createEvidencePackageEntry(archive, entry.ArchivePath)
		if err != nil {
			_ = object.Body.Close()
			return 0, err
		}
		hash := sha256.New()
		written, copyErr := io.Copy(writer, io.TeeReader(object.Body, hash))
		closeErr := object.Body.Close()
		if copyErr != nil || closeErr != nil {
			return 0, errors.Join(copyErr, closeErr)
		}
		actual := hex.EncodeToString(hash.Sum(nil))
		if actual != entry.ExpectedSHA256 {
			return 0, fmt.Errorf("証跡画像のSHA-256が一致しません: %s", entry.ArchivePath)
		}
		files = append(files, evidencePackageFile{Path: entry.ArchivePath, SHA256: actual, Bytes: written})
	}
	manifest, err := json.MarshalIndent(evidencePackageManifest{
		SchemaVersion: "1", ExportID: prepared.ExportID,
		GeneratedAt: generatedAt.UTC().Format(time.RFC3339Nano),
		TenantKey:   prepared.TenantKey, ApplicationKey: prepared.ApplicationKey, EnvironmentKey: prepared.EnvironmentKey,
		ExternalWorkspaceKey: prepared.ExternalWorkspaceKey, SessionID: prepared.SessionID, Files: files,
	}, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("evidence package manifestを生成できません: %w", err)
	}
	if err := writeEvidencePackageBytes(archive, "manifest.json", append(manifest, '\n')); err != nil {
		return 0, err
	}
	if err := archive.Close(); err != nil {
		return 0, fmt.Errorf("evidence package ZIPを閉じられません: %w", err)
	}
	if err := file.Sync(); err != nil {
		return 0, fmt.Errorf("evidence packageを同期できません: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	if err := file.Close(); err != nil {
		return 0, err
	}
	complete = true
	return info.Size(), nil
}

func validateEvidencePackagePath(name string) error {
	if name == "" || strings.HasPrefix(name, "/") || path.Clean(name) != name || strings.HasPrefix(name, "../") {
		return fmt.Errorf("evidence package内のpathが不正です: %q", name)
	}
	return nil
}

func writeEvidencePackageBytes(archive *zip.Writer, name string, data []byte) error {
	writer, err := createEvidencePackageEntry(archive, name)
	if err != nil {
		return err
	}
	if _, err := writer.Write(data); err != nil {
		return fmt.Errorf("evidence package entryを書けません: %w", err)
	}
	return nil
}

func createEvidencePackageEntry(archive *zip.Writer, name string) (io.Writer, error) {
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.Modified = time.Unix(0, 0).UTC()
	writer, err := archive.CreateHeader(header)
	if err != nil {
		return nil, fmt.Errorf("evidence package entryを作成できません: %w", err)
	}
	return writer, nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
