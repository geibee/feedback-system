package export

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/objectstore"
)

func TestWriteEvidencePackageIncludesNormalizedDataEvidenceAndManifest(t *testing.T) {
	t.Parallel()
	objects, err := objectstore.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer objects.Close()
	evidence := []byte("image bytes")
	if err := objects.Put(context.Background(), "evidence/image.png", "image/png", evidence); err != nil {
		t.Fatal(err)
	}
	value := "=HYPERLINK(\"https://invalid.example\")"
	archivePath := t.TempDir() + "/evidence.zip"
	_, err = WriteEvidencePackage(context.Background(), EvidencePackage{
		ExportID: "export-1", ApplicationKey: "app", EnvironmentKey: "test",
		ExternalWorkspaceKey: "workspace",
		CSVEntries: []CSVEntry{{
			Path: "data/messages.csv", Header: []string{"body"}, Rows: [][]*string{{&value}},
		}},
		EvidenceEntries: []EvidenceEntry{{
			ArchivePath: "evidence/thread-1/image.png", ObjectKey: "evidence/image.png",
			ExpectedSHA256: sha256Hex(evidence),
		}},
	}, objects, archivePath, time.Date(2026, 8, 19, 1, 2, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	entries := make(map[string][]byte)
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatal(readErr, closeErr)
		}
		entries[file.Name] = data
	}
	if string(entries["evidence/thread-1/image.png"]) != string(evidence) {
		t.Fatal("証跡画像がarchiveへ保存されていません")
	}
	if !strings.Contains(string(entries["data/messages.csv"]), "'=HYPERLINK") {
		t.Fatalf("CSV式injectionが無効化されていません: %q", entries["data/messages.csv"])
	}
	var manifest evidencePackageManifest
	if err := json.Unmarshal(entries["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.ExportID != "export-1" || len(manifest.Files) != 2 ||
		manifest.Files[1].SHA256 != sha256Hex(evidence) {
		t.Fatalf("manifest = %+v", manifest)
	}
}
