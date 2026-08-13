// Package manifestapply はapplication manifestを認可済みHTTP APIへ宣言的に同期する。
package manifestapply

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	maximumManifestBytes = 4 * 1024 * 1024
	maximumResponseBytes = 4 * 1024 * 1024
	maximumTokenBytes    = 64 * 1024
	requestTimeout       = 30 * time.Second
)

var applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

var (
	ErrInvalidSettings = errors.New("manifest apply設定が不正です")
	ErrRemote          = errors.New("manifest API呼出に失敗しました")
	ErrPrecondition    = errors.New("manifestが別の処理で更新されました")
)

// Settings は単一manifest同期の入力と認証方法を表す。
type Settings struct {
	APIBaseURL      string
	ManifestFile    string
	AccessToken     string
	AccessTokenFile string
	TokenURL        string
	ClientID        string
	ClientSecret    string
	Scope           string
	AllowHTTP       bool
}

// Result はapplyが変更を行ったかと確定ETagを返す。
type Result struct {
	ApplicationKey  string
	ManifestVersion string
	ETag            string
	Changed         bool
}

type manifestIdentity struct {
	ApplicationKey  string `json:"applicationKey"`
	ManifestVersion string `json:"manifestVersion"`
}

// Client はredirect時にcredentialを転送しないmanifest同期clientである。
type Client struct{ httpClient *http.Client }

func NewClient(httpClient *http.Client) (*Client, error) {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	}
	isolated := *httpClient
	if isolated.Timeout <= 0 {
		isolated.Timeout = requestTimeout
	}
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{httpClient: &isolated}, nil
}

// Apply は現行ETagを取得し、差分がある場合だけ楽観ロック付きPUTを行う。
func (client *Client) Apply(ctx context.Context, settings Settings) (Result, error) {
	settings, err := validateSettings(settings)
	if err != nil {
		return Result{}, err
	}
	manifest, identity, err := readManifest(settings.ManifestFile)
	if err != nil {
		return Result{}, err
	}
	token, err := client.accessToken(ctx, settings)
	if err != nil {
		return Result{}, err
	}
	endpoint := settings.APIBaseURL + "/applications/" + url.PathEscape(identity.ApplicationKey) + "/manifest"

	current, etag, exists, err := client.get(ctx, endpoint, token)
	if err != nil {
		return Result{}, err
	}
	if exists {
		equal, compareErr := equalJSON(current, manifest)
		if compareErr != nil {
			return Result{}, compareErr
		}
		if equal {
			return Result{
				ApplicationKey: identity.ApplicationKey, ManifestVersion: identity.ManifestVersion,
				ETag: etag, Changed: false,
			}, nil
		}
	}
	resultETag, err := client.put(ctx, endpoint, token, manifest, etag, exists)
	if err != nil {
		return Result{}, err
	}
	return Result{
		ApplicationKey: identity.ApplicationKey, ManifestVersion: identity.ManifestVersion,
		ETag: resultETag, Changed: true,
	}, nil
}

func validateSettings(settings Settings) (Settings, error) {
	settings.APIBaseURL = strings.TrimRight(strings.TrimSpace(settings.APIBaseURL), "/")
	settings.ManifestFile = strings.TrimSpace(settings.ManifestFile)
	settings.AccessToken = strings.TrimSpace(settings.AccessToken)
	settings.AccessTokenFile = strings.TrimSpace(settings.AccessTokenFile)
	settings.TokenURL = strings.TrimSpace(settings.TokenURL)
	settings.ClientID = strings.TrimSpace(settings.ClientID)
	settings.ClientSecret = strings.TrimSpace(settings.ClientSecret)
	settings.Scope = strings.TrimSpace(settings.Scope)
	if settings.APIBaseURL == "" || settings.ManifestFile == "" {
		return Settings{}, invalid("API base URLとmanifest fileが必要です")
	}
	if err := validateHTTPURL(settings.APIBaseURL, settings.AllowHTTP); err != nil {
		return Settings{}, err
	}
	directCredentials := 0
	if settings.AccessToken != "" {
		directCredentials++
	}
	if settings.AccessTokenFile != "" {
		directCredentials++
	}
	oauthFields := []string{settings.TokenURL, settings.ClientID, settings.ClientSecret}
	oauthConfigured := 0
	for _, value := range oauthFields {
		if value != "" {
			oauthConfigured++
		}
	}
	if directCredentials > 1 || (directCredentials > 0 && oauthConfigured > 0) {
		return Settings{}, invalid("Bearer tokenとOAuth client credentialsはどちらか一方だけ指定してください")
	}
	if directCredentials == 0 && oauthConfigured != len(oauthFields) {
		return Settings{}, invalid("Bearer token、token file、または完全なOAuth client credentialsが必要です")
	}
	if directCredentials == 0 {
		if err := validateHTTPURL(settings.TokenURL, settings.AllowHTTP); err != nil {
			return Settings{}, err
		}
		if settings.Scope == "" {
			settings.Scope = "openid"
		}
	}
	return settings, nil
}

func validateHTTPURL(raw string, allowHTTP bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return invalid("HTTP URLが不正です")
	}
	if parsed.Scheme != "https" && !(allowHTTP && parsed.Scheme == "http") {
		return invalid("HTTP URLはhttpsで指定してください")
	}
	return nil
}

func readManifest(path string) ([]byte, manifestIdentity, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, manifestIdentity{}, fmt.Errorf("manifest fileを開けません: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, manifestIdentity{}, invalid("manifest fileはregular fileを指定してください")
	}
	contents, err := io.ReadAll(io.LimitReader(file, maximumManifestBytes+1))
	if err != nil {
		return nil, manifestIdentity{}, fmt.Errorf("manifest fileを読めません: %w", err)
	}
	if len(contents) == 0 || len(contents) > maximumManifestBytes {
		return nil, manifestIdentity{}, invalid("manifest fileのsizeが不正です")
	}
	var identity manifestIdentity
	decoder := json.NewDecoder(bytes.NewReader(contents))
	if err := decoder.Decode(&identity); err != nil {
		return nil, manifestIdentity{}, invalid("manifest fileがJSON objectではありません")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, manifestIdentity{}, invalid("manifest fileの末尾に余分なJSONがあります")
	}
	if !applicationKeyPattern.MatchString(identity.ApplicationKey) || strings.TrimSpace(identity.ManifestVersion) == "" {
		return nil, manifestIdentity{}, invalid("manifest identityが不正です")
	}
	return contents, identity, nil
}

func (client *Client) accessToken(ctx context.Context, settings Settings) (string, error) {
	if settings.AccessToken != "" {
		return settings.AccessToken, nil
	}
	if settings.AccessTokenFile != "" {
		file, err := os.Open(settings.AccessTokenFile)
		if err != nil {
			return "", fmt.Errorf("access token fileを読めません: %w", err)
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return "", invalid("access token fileはregular fileを指定してください")
		}
		contents, err := io.ReadAll(io.LimitReader(file, maximumTokenBytes+1))
		if err != nil {
			return "", fmt.Errorf("access token fileを読めません: %w", err)
		}
		token := strings.TrimSpace(string(contents))
		if token == "" || len(contents) > maximumTokenBytes {
			return "", invalid("access token fileのsizeが不正です")
		}
		return token, nil
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {settings.ClientID},
		"client_secret": {settings.ClientSecret},
		"scope":         {settings.Scope},
	}
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, settings.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return "", &RemoteError{Status: 0, Detail: "OIDC tokenを取得できません", cause: err}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return "", remote(response.StatusCode, "OIDC tokenを取得できません")
	}
	var value struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := decodeBoundedJSON(response.Body, &value); err != nil || strings.TrimSpace(value.AccessToken) == "" ||
		(value.TokenType != "" && !strings.EqualFold(value.TokenType, "Bearer")) {
		return "", remote(response.StatusCode, "OIDC token応答が不正です")
	}
	return value.AccessToken, nil
}

func (client *Client) get(ctx context.Context, endpoint, token string) ([]byte, string, bool, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", false, err
	}
	setRequestHeaders(request, token)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, "", false, &RemoteError{Status: 0, Detail: "現在のmanifestを取得できません", cause: err}
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, "", false, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, "", false, remote(response.StatusCode, "現在のmanifestを取得できません")
	}
	etag := strings.TrimSpace(response.Header.Get("ETag"))
	if etag == "" {
		return nil, "", false, remote(response.StatusCode, "manifest GET応答にETagがありません")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(body) > maximumResponseBytes {
		return nil, "", false, remote(response.StatusCode, "manifest GET応答を読めません")
	}
	return body, etag, true, nil
}

func (client *Client) put(ctx context.Context, endpoint, token string, manifest []byte, etag string, exists bool) (string, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPut, endpoint, bytes.NewReader(manifest))
	if err != nil {
		return "", err
	}
	setRequestHeaders(request, token)
	request.Header.Set("Content-Type", "application/json")
	if exists {
		request.Header.Set("If-Match", etag)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return "", &RemoteError{Status: 0, Detail: "manifestを登録できません", cause: err}
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusPreconditionFailed {
		return "", &RemoteError{Status: response.StatusCode, Detail: ErrPrecondition.Error(), cause: ErrPrecondition}
	}
	if response.StatusCode != http.StatusOK {
		return "", remote(response.StatusCode, "manifestを登録できません")
	}
	resultETag := strings.TrimSpace(response.Header.Get("ETag"))
	if resultETag == "" {
		return "", remote(response.StatusCode, "manifest PUT応答にETagがありません")
	}
	return resultETag, nil
}

func setRequestHeaders(request *http.Request, token string) {
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Request-ID", uuid.NewString())
}

func equalJSON(left, right []byte) (bool, error) {
	var leftValue, rightValue any
	if err := json.Unmarshal(left, &leftValue); err != nil {
		return false, remote(http.StatusOK, "保存済みmanifestが不正です")
	}
	if err := json.Unmarshal(right, &rightValue); err != nil {
		return false, invalid("manifest fileが不正です")
	}
	leftJSON, _ := json.Marshal(leftValue)
	rightJSON, _ := json.Marshal(rightValue)
	return bytes.Equal(leftJSON, rightJSON), nil
}

func decodeBoundedJSON(reader io.Reader, destination any) error {
	contents, err := io.ReadAll(io.LimitReader(reader, maximumResponseBytes+1))
	if err != nil || len(contents) > maximumResponseBytes {
		return errors.New("JSON応答が大きすぎます")
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("余分なJSONがあります")
		}
		return err
	}
	return nil
}

func invalid(detail string) error {
	return fmt.Errorf("%w: %s", ErrInvalidSettings, detail)
}

func remote(status int, detail string) error {
	return &RemoteError{Status: status, Detail: detail, cause: ErrRemote}
}

// RemoteError はsecretやremote response bodyを含めずにHTTP失敗を伝える。
type RemoteError struct {
	Status int
	Detail string
	cause  error
}

func (err *RemoteError) Error() string {
	if err.Status == 0 {
		return err.Detail
	}
	return fmt.Sprintf("%s: HTTP %d", err.Detail, err.Status)
}

func (err *RemoteError) Unwrap() error { return err.cause }
