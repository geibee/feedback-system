package objectstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/to"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"

	serviceconfig "github.com/geibee/feedback-system/apps/feedback-service-go/internal/config"
)

var errObjectSizeMismatch = errors.New("object sizeが一致しません")

type azureBlobBackend interface {
	Upload(context.Context, string, string, io.Reader) error
	Download(context.Context, string) (Object, error)
	Delete(context.Context, string) error
	List(context.Context, string, int32) ([]Ref, error)
}

// AzureBlob はManaged Identityでprivate Azure Blob containerへ接続するadapterである。
type AzureBlob struct {
	backend azureBlobBackend
	prefix  string
}

func NewAzureBlob(settings serviceconfig.StorageSettings) (*AzureBlob, error) {
	if strings.TrimSpace(settings.AccountURL) == "" {
		return nil, errors.New("Azure Blob account URLが未設定です")
	}
	if strings.TrimSpace(settings.Container) == "" {
		return nil, errors.New("Azure Blob containerが未設定です")
	}
	clientID := strings.TrimSpace(os.Getenv("AZURE_CLIENT_ID"))
	if clientID == "" {
		return nil, errors.New("Azure Blob利用時はAZURE_CLIENT_IDが必須です")
	}
	credential, err := azidentity.NewManagedIdentityCredential(&azidentity.ManagedIdentityCredentialOptions{
		ID: azidentity.ClientID(clientID),
	})
	if err != nil {
		return nil, fmt.Errorf("Azure Managed Identity credentialを初期化できません: %w", err)
	}
	client, err := azblob.NewClient(settings.AccountURL, credential, nil)
	if err != nil {
		return nil, fmt.Errorf("Azure Blob clientを初期化できません: %w", err)
	}
	return &AzureBlob{
		backend: &azureSDKBackend{client: client, container: settings.Container},
		prefix:  settings.KeyPrefix,
	}, nil
}

func (storage *AzureBlob) Put(ctx context.Context, key string, contentType string, data []byte) error {
	return storage.PutReader(ctx, key, contentType, bytes.NewReader(data), int64(len(data)))
}

func (storage *AzureBlob) PutReader(
	ctx context.Context, key string, contentType string, reader io.Reader, size int64,
) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	if reader == nil || size < 0 {
		return errors.New("object readerまたはsizeが不正です")
	}
	exact := &exactSizeReader{value: reader, expected: size}
	if err := storage.backend.Upload(ctx, key, contentType, exact); err != nil {
		if errors.Is(err, errObjectSizeMismatch) {
			return fmt.Errorf("%w: got=%d want=%d", errObjectSizeMismatch, exact.read, size)
		}
		return fmt.Errorf("Azure Blob objectを書き込めません: %w", err)
	}
	if exact.read != size || !exact.finished {
		return fmt.Errorf("%w: got=%d want=%d", errObjectSizeMismatch, exact.read, size)
	}
	return nil
}

func (storage *AzureBlob) Get(ctx context.Context, key string) (Object, error) {
	if err := ValidateKey(key); err != nil {
		return Object{}, err
	}
	object, err := storage.backend.Download(ctx, key)
	if err != nil {
		return Object{}, fmt.Errorf("Azure Blob objectを読み取れません: %w", err)
	}
	return object, nil
}

func (storage *AzureBlob) Delete(ctx context.Context, key string) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	if err := storage.backend.Delete(ctx, key); err != nil {
		return fmt.Errorf("Azure Blob objectを削除できません: %w", err)
	}
	return nil
}

func (storage *AzureBlob) List(ctx context.Context, prefix string) ([]Ref, error) {
	if err := ValidatePrefix(prefix); err != nil {
		return nil, err
	}
	refs, err := storage.backend.List(ctx, prefix, 0)
	if err != nil {
		return nil, fmt.Errorf("Azure Blob objectsを一覧できません: %w", err)
	}
	slices.SortFunc(refs, func(left, right Ref) int { return strings.Compare(left.Key, right.Key) })
	return refs, nil
}

func (storage *AzureBlob) CheckReadiness(ctx context.Context) error {
	if _, err := storage.backend.List(ctx, storage.prefix, 1); err != nil {
		return fmt.Errorf("Azure Blob object storageを一覧できません: %w", err)
	}
	return nil
}

func (storage *AzureBlob) Close() error { return nil }

type azureSDKBackend struct {
	client    *azblob.Client
	container string
}

func (backend *azureSDKBackend) Upload(
	ctx context.Context, key string, contentType string, reader io.Reader,
) error {
	star := azcore.ETag("*")
	_, err := backend.client.UploadStream(ctx, backend.container, key, reader, &azblob.UploadStreamOptions{
		Concurrency: 1,
		HTTPHeaders: &blob.HTTPHeaders{BlobContentType: to.Ptr(contentType)},
		AccessConditions: &blob.AccessConditions{
			ModifiedAccessConditions: &blob.ModifiedAccessConditions{IfNoneMatch: &star},
		},
	})
	if isAzureStatus(err, http.StatusPreconditionFailed, http.StatusConflict) {
		return fmt.Errorf("%w: %s", ErrAlreadyExists, key)
	}
	return err
}

func (backend *azureSDKBackend) Download(ctx context.Context, key string) (Object, error) {
	response, err := backend.client.DownloadStream(ctx, backend.container, key, nil)
	if isAzureStatus(err, http.StatusNotFound) {
		return Object{}, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return Object{}, err
	}
	var contentType string
	if response.ContentType != nil {
		contentType = *response.ContentType
	}
	var size int64 = -1
	if response.ContentLength != nil {
		size = *response.ContentLength
	}
	var lastModified time.Time
	if response.LastModified != nil {
		lastModified = *response.LastModified
	}
	return Object{
		Key: key, ContentType: contentType, Size: size, LastModified: lastModified,
		Body: &contextReadCloser{ctx: ctx, value: response.NewRetryReader(ctx, nil)},
	}, nil
}

func (backend *azureSDKBackend) Delete(ctx context.Context, key string) error {
	_, err := backend.client.DeleteBlob(ctx, backend.container, key, nil)
	if isAzureStatus(err, http.StatusNotFound) {
		return nil
	}
	return err
}

func (backend *azureSDKBackend) List(ctx context.Context, prefix string, maximum int32) ([]Ref, error) {
	options := &azblob.ListBlobsFlatOptions{Prefix: to.Ptr(prefix)}
	if maximum > 0 {
		options.MaxResults = &maximum
	}
	pager := backend.client.NewListBlobsFlatPager(backend.container, options)
	result := make([]Ref, 0)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		if page.Segment == nil {
			continue
		}
		for _, item := range page.Segment.BlobItems {
			if item == nil || item.Name == nil || item.Properties == nil || item.Properties.LastModified == nil {
				continue
			}
			result = append(result, Ref{Key: *item.Name, LastModified: *item.Properties.LastModified})
			if maximum > 0 && int32(len(result)) >= maximum {
				return result, nil
			}
		}
	}
	return result, nil
}

func isAzureStatus(err error, statuses ...int) bool {
	if err == nil {
		return false
	}
	var responseErr *azcore.ResponseError
	return errors.As(err, &responseErr) && slices.Contains(statuses, responseErr.StatusCode)
}

type exactSizeReader struct {
	value    io.Reader
	expected int64
	read     int64
	finished bool
}

func (reader *exactSizeReader) Read(buffer []byte) (int, error) {
	if reader.read == reader.expected {
		var probe [1]byte
		n, err := reader.value.Read(probe[:])
		if n > 0 {
			return 0, errObjectSizeMismatch
		}
		if errors.Is(err, io.EOF) {
			reader.finished = true
			return 0, io.EOF
		}
		return 0, err
	}
	remaining := reader.expected - reader.read
	if int64(len(buffer)) > remaining {
		buffer = buffer[:remaining]
	}
	n, err := reader.value.Read(buffer)
	reader.read += int64(n)
	if errors.Is(err, io.EOF) {
		if reader.read != reader.expected {
			return n, errObjectSizeMismatch
		}
		reader.finished = true
	}
	return n, err
}
