package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
)

func TestAzureBlobObjectLifecycle(t *testing.T) {
	t.Parallel()
	backend := newAzureBackendFake()
	storage := &AzureBlob{backend: backend, prefix: "evidence/"}
	ctx := context.Background()
	key := "evidence/tenant/workspace/object"
	payload := []byte("payload")

	if err := storage.PutReader(ctx, key, "image/png", bytes.NewReader(payload), int64(len(payload))); err != nil {
		t.Fatalf("PutReader() error=%v", err)
	}
	if err := storage.Put(ctx, key, "image/png", []byte("replacement")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second Put() error=%v, want ErrAlreadyExists", err)
	}
	object, err := storage.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get() error=%v", err)
	}
	actual, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || object.ContentType != "image/png" ||
		object.Size != int64(len(payload)) || !bytes.Equal(actual, payload) || object.LastModified.IsZero() {
		t.Fatalf("object=%+v body=%q read=%v close=%v", object, actual, readErr, closeErr)
	}
	backend.objects["evidence/a"] = azureObjectFake{contentType: "text/plain", data: []byte("a"), modified: time.Now()}
	refs, err := storage.List(ctx, "evidence/")
	if err != nil || len(refs) != 2 || refs[0].Key != "evidence/a" || refs[1].Key != key {
		t.Fatalf("List() refs=%+v error=%v", refs, err)
	}
	if err := storage.CheckReadiness(ctx); err != nil || backend.lastMaximum != 1 || backend.lastPrefix != "evidence/" {
		t.Fatalf("CheckReadiness() error=%v maximum=%d prefix=%q", err, backend.lastMaximum, backend.lastPrefix)
	}
	if err := storage.Delete(ctx, key); err != nil {
		t.Fatalf("Delete() error=%v", err)
	}
	if err := storage.Delete(ctx, key); err != nil {
		t.Fatalf("idempotent Delete() error=%v", err)
	}
	if _, err := storage.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(deleted) error=%v, want ErrNotFound", err)
	}
}

func TestAzureBlobPutReaderRequiresExactSize(t *testing.T) {
	t.Parallel()
	for name, fixture := range map[string]struct {
		body string
		size int64
	}{
		"short": {body: "abc", size: 4},
		"long":  {body: "abcd", size: 3},
	} {
		name, fixture := name, fixture
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			backend := newAzureBackendFake()
			storage := &AzureBlob{backend: backend}
			err := storage.PutReader(
				context.Background(), "objects/"+name, "application/octet-stream",
				strings.NewReader(fixture.body), fixture.size,
			)
			if !errors.Is(err, errObjectSizeMismatch) {
				t.Fatalf("PutReader() error=%v, want size mismatch", err)
			}
			if len(backend.objects) != 0 {
				t.Fatalf("size不一致objectが残りました: %+v", backend.objects)
			}
		})
	}
}

func TestAzureBlobPropagatesCancellationAndReadinessFailure(t *testing.T) {
	t.Parallel()
	backend := newAzureBackendFake()
	storage := &AzureBlob{backend: backend, prefix: "exports/"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := storage.Put(ctx, "exports/object", "application/zip", []byte("data")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put() error=%v, want context.Canceled", err)
	}
	backend.listError = errors.New("RBAC denied")
	if err := storage.CheckReadiness(context.Background()); err == nil {
		t.Fatal("Azure Blob障害時にreadinessが成功しました")
	}
}

func TestAzureBlobStatusNormalization(t *testing.T) {
	t.Parallel()
	if !isAzureStatus(&azcore.ResponseError{StatusCode: http.StatusNotFound, ErrorCode: "BlobNotFound"}, http.StatusNotFound) {
		t.Fatal("Azure 404を認識できませんでした")
	}
	if isAzureStatus(errors.New("404という文字列だけのerror"), http.StatusNotFound) {
		t.Fatal("型なしerrorをAzure statusとして認識しました")
	}
}

type azureObjectFake struct {
	contentType string
	data        []byte
	modified    time.Time
}

type azureBackendFake struct {
	objects     map[string]azureObjectFake
	lastPrefix  string
	lastMaximum int32
	listError   error
}

func newAzureBackendFake() *azureBackendFake {
	return &azureBackendFake{objects: make(map[string]azureObjectFake)}
}

func (backend *azureBackendFake) Upload(
	ctx context.Context, key string, contentType string, reader io.Reader,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, exists := backend.objects[key]; exists {
		return ErrAlreadyExists
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	backend.objects[key] = azureObjectFake{
		contentType: contentType, data: append([]byte(nil), data...), modified: time.Now().UTC(),
	}
	return nil
}

func (backend *azureBackendFake) Download(ctx context.Context, key string) (Object, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, err
	}
	value, exists := backend.objects[key]
	if !exists {
		return Object{}, ErrNotFound
	}
	return Object{
		Key: key, ContentType: value.contentType, Size: int64(len(value.data)), LastModified: value.modified,
		Body: io.NopCloser(bytes.NewReader(value.data)),
	}, nil
}

func (backend *azureBackendFake) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	delete(backend.objects, key)
	return nil
}

func (backend *azureBackendFake) List(ctx context.Context, prefix string, maximum int32) ([]Ref, error) {
	backend.lastPrefix = prefix
	backend.lastMaximum = maximum
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if backend.listError != nil {
		return nil, backend.listError
	}
	result := make([]Ref, 0)
	for key, value := range backend.objects {
		if strings.HasPrefix(key, prefix) {
			result = append(result, Ref{Key: key, LastModified: value.modified})
			if maximum > 0 && int32(len(result)) >= maximum {
				break
			}
		}
	}
	return result, nil
}

var _ azureBlobBackend = (*azureBackendFake)(nil)
