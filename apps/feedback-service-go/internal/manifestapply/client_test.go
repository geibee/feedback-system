package manifestapply

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestApplyCreatesManifestAndUsesBearerToken(t *testing.T) {
	t.Parallel()
	manifestFile := writeManifest(t, "v1", "在庫")
	var getCount, putCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer direct-token" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("X-Request-ID") == "" {
			t.Error("X-Request-IDがありません")
		}
		switch request.Method {
		case http.MethodGet:
			getCount.Add(1)
			http.NotFound(writer, request)
		case http.MethodPut:
			putCount.Add(1)
			if request.Header.Get("If-Match") != "" {
				t.Errorf("初回If-Match = %q", request.Header.Get("If-Match"))
			}
			body, _ := io.ReadAll(request.Body)
			if !strings.Contains(string(body), `"manifestVersion":"v1"`) {
				t.Errorf("manifest body = %s", body)
			}
			writer.Header().Set("ETag", `"v1"`)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write(body)
		default:
			http.Error(writer, "method", http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.Client())
	result, err := client.Apply(context.Background(), Settings{
		APIBaseURL: server.URL + "/feedback/v1", ManifestFile: manifestFile,
		AccessToken: "direct-token", AllowHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.ApplicationKey != "inventory" || result.ManifestVersion != "v1" || result.ETag != `"v1"` ||
		getCount.Load() != 1 || putCount.Load() != 1 {
		t.Fatalf("result=%+v get=%d put=%d", result, getCount.Load(), putCount.Load())
	}
}

func TestApplyUpdatesWithCurrentETag(t *testing.T) {
	t.Parallel()
	manifestFile := writeManifest(t, "v2", "在庫 v2")
	var putCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodGet:
			writer.Header().Set("ETag", `"v7"`)
			_, _ = writer.Write([]byte(`{"schemaVersion":"1","applicationKey":"inventory","displayName":"在庫","manifestVersion":"v1","routes":[{"pageKey":"home","template":"/","label":"ホーム"}]}`))
		case http.MethodPut:
			putCount.Add(1)
			if request.Header.Get("If-Match") != `"v7"` {
				t.Errorf("If-Match = %q", request.Header.Get("If-Match"))
			}
			writer.Header().Set("ETag", `"v8"`)
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.Client())
	result, err := client.Apply(context.Background(), Settings{
		APIBaseURL: server.URL, ManifestFile: manifestFile, AccessToken: "token", AllowHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.ETag != `"v8"` || putCount.Load() != 1 {
		t.Fatalf("result=%+v put=%d", result, putCount.Load())
	}
}

func TestApplySkipsEquivalentManifest(t *testing.T) {
	t.Parallel()
	manifestFile := writeManifest(t, "v1", "在庫")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Fatalf("変更なしで%sされました", request.Method)
		}
		writer.Header().Set("ETag", `"v3"`)
		_, _ = writer.Write([]byte(`{
  "routes":[{"label":"ホーム","template":"/","pageKey":"home"}],
  "manifestVersion":"v1","displayName":"在庫","applicationKey":"inventory","schemaVersion":"1"
}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.Client())
	result, err := client.Apply(context.Background(), Settings{
		APIBaseURL: server.URL, ManifestFile: manifestFile, AccessToken: "token", AllowHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed || result.ETag != `"v3"` {
		t.Fatalf("result=%+v", result)
	}
}

func TestApplyObtainsOAuthTokenAndFailsClosedOnStaleETag(t *testing.T) {
	t.Parallel()
	manifestFile := writeManifest(t, "v2", "在庫 v2")
	secret := "client-secret-value"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/token":
			body, _ := io.ReadAll(request.Body)
			encoded := string(body)
			if !strings.Contains(encoded, "grant_type=client_credentials") || !strings.Contains(encoded, "client_id=manifest-sync") ||
				!strings.Contains(encoded, "client_secret="+secret) || !strings.Contains(encoded, "scope=feedback.admin") {
				t.Errorf("token request = %q", encoded)
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"access_token":"oauth-token","token_type":"Bearer"}`))
		case "/applications/inventory/manifest":
			if request.Header.Get("Authorization") != "Bearer oauth-token" {
				t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
			}
			if request.Method == http.MethodGet {
				writer.Header().Set("ETag", `"v4"`)
				_, _ = writer.Write([]byte(`{"schemaVersion":"1","applicationKey":"inventory","displayName":"在庫","manifestVersion":"v1","routes":[{"pageKey":"home","template":"/","label":"ホーム"}]}`))
				return
			}
			if request.Header.Get("If-Match") != `"v4"` {
				t.Errorf("If-Match = %q", request.Header.Get("If-Match"))
			}
			writer.WriteHeader(http.StatusPreconditionFailed)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.Client())
	_, err := client.Apply(context.Background(), Settings{
		APIBaseURL: server.URL, ManifestFile: manifestFile, TokenURL: server.URL + "/token",
		ClientID: "manifest-sync", ClientSecret: secret, Scope: "feedback.admin", AllowHTTP: true,
	})
	if !errors.Is(err, ErrPrecondition) || strings.Contains(fmt.Sprint(err), secret) {
		t.Fatalf("error = %v", err)
	}
}

func TestApplyRejectsMissingETagAndAmbiguousCredentials(t *testing.T) {
	t.Parallel()
	manifestFile := writeManifest(t, "v1", "在庫")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"schemaVersion":"1","applicationKey":"inventory","displayName":"在庫","manifestVersion":"v1","routes":[]}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.Client())
	_, err := client.Apply(context.Background(), Settings{
		APIBaseURL: server.URL, ManifestFile: manifestFile, AccessToken: "token", AllowHTTP: true,
	})
	if !errors.Is(err, ErrRemote) || !strings.Contains(err.Error(), "ETag") {
		t.Fatalf("missing ETag error = %v", err)
	}
	_, err = client.Apply(context.Background(), Settings{
		APIBaseURL: server.URL, ManifestFile: manifestFile, AccessToken: "token",
		TokenURL: server.URL + "/token", ClientID: "id", ClientSecret: "secret", AllowHTTP: true,
	})
	if !errors.Is(err, ErrInvalidSettings) {
		t.Fatalf("ambiguous credential error = %v", err)
	}
}

func TestAccessTokenFileMustBeBoundedRegularFile(t *testing.T) {
	t.Parallel()

	client, _ := NewClient(nil)
	if _, err := client.accessToken(context.Background(), Settings{AccessTokenFile: t.TempDir()}); !errors.Is(err, ErrInvalidSettings) {
		t.Fatalf("directory token file error = %v", err)
	}
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, make([]byte, maximumTokenBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := client.accessToken(context.Background(), Settings{AccessTokenFile: path}); !errors.Is(err, ErrInvalidSettings) {
		t.Fatalf("oversized token file error = %v", err)
	}
}

func writeManifest(t *testing.T, version, displayName string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "manifest.json")
	contents := fmt.Sprintf(`{"schemaVersion":"1","applicationKey":"inventory","displayName":%q,"manifestVersion":%q,"routes":[{"pageKey":"home","template":"/","label":"ホーム"}]}`, displayName, version)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
