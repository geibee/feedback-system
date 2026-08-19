package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/contract"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/evidence"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/session"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/usecase"
)

const maximumDiscussionMetadataBytes int64 = 1024 * 1024

func stringValueOf[T ~string](value *T) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

func uuidString(value *openapi_types.UUID) *string {
	if value == nil {
		return nil
	}
	text := value.String()
	return &text
}

func (handler *APIHandler) ListFeedbackThreads(
	writer http.ResponseWriter,
	request *http.Request,
	sessionID contract.SessionID,
	params contract.ListFeedbackThreadsParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.ListFeedbackThreads(writer, request, sessionID, params)
		return
	}
	principal, _, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindSession, sessionID.String(), auth.PermissionRead,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	status := optionalEnum(params.Status)
	var limitValue *int
	if params.Limit != nil {
		value := int(*params.Limit)
		limitValue = &value
	}
	limit, err := ParseLimit(limitValue)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	var cursor *string
	if params.Cursor != nil {
		value := string(*params.Cursor)
		cursor = &value
	}
	offset, err := DecodeCursor(cursor)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.discussions.ListThreads(request.Context(), discussion.ListThreadsInput{
		SessionID: sessionID.String(), Status: status, Sort: stringValueOf(params.Sort),
		PerspectiveCode: params.PerspectiveCode, AssigneeUserID: uuidString(params.AssigneeUserID),
		Priority: optionalEnum(params.Priority), Label: params.Label, EvidenceAvailable: params.EvidenceAvailable,
		Query: params.Q, ViewerUserID: principal.UserID, Limit: limit, Offset: offset,
	})
	respondJSONOrError(writer, request, http.StatusOK, result, mapPhase2Error(err))
}

func (handler *APIHandler) GetFeedbackUnreadReplies(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.GetFeedbackUnreadRepliesParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.GetFeedbackUnreadReplies(writer, request, params)
		return
	}
	principal, scope, err := handler.authorizeDiscussionWorkspace(request, string(params.ApplicationKey),
		string(params.EnvironmentKey), string(params.ExternalWorkspaceKey), auth.PermissionRead)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	result, err := handler.discussions.ListUnreadReplies(request.Context(), discussion.UnreadRepliesInput{
		Scope: scope, Principal: principal,
	})
	respondJSONOrError(writer, request, http.StatusOK, result, mapPhase2Error(err))
}

func (handler *APIHandler) CreateFeedbackThread(
	writer http.ResponseWriter,
	request *http.Request,
	sessionID contract.SessionID,
	params contract.CreateFeedbackThreadParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.CreateFeedbackThread(writer, request, sessionID, params)
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindSession, sessionID.String(), auth.PermissionComment,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	if err := handler.enforceDiscussionRateLimit(request, principal, scope); err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	body, err := readBoundedBody(request.Body, handler.maximumThreadRequestBytes())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	input, err := handler.decodeThreadCreate(body)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	requestHash, err := CanonicalJSONSHA256(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.discussions.CreateThread(request.Context(), discussion.CreateThreadInput{
		Scope: scope, SessionID: sessionID.String(), Principal: principal, Request: input,
		IdempotencyKey: string(params.IdempotencyKey), RequestHash: requestHash,
		RequestID: RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Value.Version))
	respondJSONOrError(writer, request, http.StatusCreated, result.Value, nil)
}

func (handler *APIHandler) GetFeedbackThread(
	writer http.ResponseWriter,
	request *http.Request,
	threadID contract.ThreadID,
) {
	if handler.discussions == nil {
		handler.Unimplemented.GetFeedbackThread(writer, request, threadID)
		return
	}
	principal, _, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindThread, threadID.String(), auth.PermissionRead,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	result, err := handler.discussions.GetThreadForViewer(request.Context(), threadID.String(), principal.UserID)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) GetFeedbackThreadDeepLink(
	writer http.ResponseWriter,
	request *http.Request,
	threadID contract.ThreadID,
) {
	if handler.discussions == nil {
		handler.Unimplemented.GetFeedbackThreadDeepLink(writer, request, threadID)
		return
	}
	_, _, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindThread, threadID.String(), auth.PermissionRead,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	result, err := handler.discussions.GetThreadDeepLink(request.Context(), threadID.String())
	respondJSONOrError(writer, request, http.StatusOK, struct {
		URL string `json:"url"`
	}{URL: result}, mapPhase2Error(err))
}

func (handler *APIHandler) CreateFeedbackMessage(
	writer http.ResponseWriter,
	request *http.Request,
	threadID contract.ThreadID,
	params contract.CreateFeedbackMessageParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.CreateFeedbackMessage(writer, request, threadID, params)
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindThread, threadID.String(), auth.PermissionComment,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	if err := handler.enforceDiscussionRateLimit(request, principal, scope); err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	body, err := readBoundedBody(request.Body, maximumDiscussionMetadataBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	input, err := decodeMessageCreate(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	requestHash, err := CanonicalJSONSHA256(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.discussions.CreateMessage(request.Context(), discussion.CreateMessageInput{
		Scope: scope, ThreadID: threadID.String(), Principal: principal, Request: input,
		IdempotencyKey: string(params.IdempotencyKey), RequestHash: requestHash,
		RequestID: RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Value.Version))
	respondJSONOrError(writer, request, http.StatusCreated, result.Value, nil)
}

func (handler *APIHandler) PatchFeedbackMessage(
	writer http.ResponseWriter,
	request *http.Request,
	messageID contract.MessageID,
	params contract.PatchFeedbackMessageParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.PatchFeedbackMessage(writer, request, messageID, params)
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindMessage, messageID.String(), auth.PermissionComment,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	body, err := readBoundedBody(request.Body, maximumDiscussionMetadataBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	input, err := decodeMessagePatch(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	version, err := ParseRequiredETag(string(params.IfMatch))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.discussions.PatchMessage(request.Context(), discussion.PatchMessageInput{
		Scope: scope, MessageID: messageID.String(), Principal: principal,
		ExpectedVersion: version, Request: input, RequestID: RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) ListFeedbackMessageVersions(
	writer http.ResponseWriter,
	request *http.Request,
	messageID contract.MessageID,
) {
	if handler.discussions == nil {
		handler.Unimplemented.ListFeedbackMessageVersions(writer, request, messageID)
		return
	}
	_, _, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindMessage, messageID.String(), auth.PermissionRead,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	result, err := handler.discussions.ListMessageVersions(request.Context(), messageID.String())
	respondJSONOrError(writer, request, http.StatusOK, result, mapPhase2Error(err))
}

func (handler *APIHandler) PutFeedbackMessageReaction(
	writer http.ResponseWriter, request *http.Request, messageID contract.MessageID, reaction contract.FeedbackReactionKey,
) {
	handler.setFeedbackMessageReaction(writer, request, messageID, reaction, true)
}

func (handler *APIHandler) DeleteFeedbackMessageReaction(
	writer http.ResponseWriter, request *http.Request, messageID contract.MessageID, reaction contract.FeedbackReactionKey,
) {
	handler.setFeedbackMessageReaction(writer, request, messageID, reaction, false)
}

func (handler *APIHandler) setFeedbackMessageReaction(
	writer http.ResponseWriter, request *http.Request, messageID contract.MessageID,
	reaction contract.FeedbackReactionKey, add bool,
) {
	if handler.discussions == nil {
		WriteError(writer, request, errors.New("discussion APIが未設定です"))
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(request, session.ResourceKindMessage,
		messageID.String(), auth.PermissionComment)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	result, err := handler.discussions.SetMessageReaction(request.Context(), discussion.ReactionInput{
		Scope: scope, MessageID: messageID.String(), Principal: principal, Reaction: string(reaction), Add: add,
		RequestID: RequestIDFromContext(request.Context()),
	})
	respondJSONOrError(writer, request, http.StatusOK, result, mapPhase2Error(err))
}

func (handler *APIHandler) PatchFeedbackThreadStatus(
	writer http.ResponseWriter,
	request *http.Request,
	threadID contract.ThreadID,
	params contract.PatchFeedbackThreadStatusParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.PatchFeedbackThreadStatus(writer, request, threadID, params)
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(
		request, session.ResourceKindThread, threadID.String(), auth.PermissionManage,
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	body, err := readBoundedBody(request.Body, maximumDiscussionMetadataBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	status, err := decodeThreadStatusPatch(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	version, err := ParseRequiredETag(string(params.IfMatch))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.discussions.PatchThreadStatus(request.Context(), discussion.PatchThreadStatusInput{
		Scope: scope, ThreadID: threadID.String(), Principal: principal,
		ExpectedVersion: version, Status: status, RequestID: RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) PatchFeedbackThreadTriage(
	writer http.ResponseWriter,
	request *http.Request,
	threadID contract.ThreadID,
	params contract.PatchFeedbackThreadTriageParams,
) {
	if handler.discussions == nil {
		handler.Unimplemented.PatchFeedbackThreadTriage(writer, request, threadID, params)
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(request, session.ResourceKindThread,
		threadID.String(), auth.PermissionManage)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	body, err := readBoundedBody(request.Body, maximumDiscussionMetadataBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	patch, err := decodeThreadTriagePatch(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	version, err := ParseRequiredETag(string(params.IfMatch))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.discussions.PatchThreadTriage(request.Context(), discussion.PatchThreadTriageInput{
		Scope: scope, ThreadID: threadID.String(), Principal: principal, ExpectedVersion: version,
		Patch: patch, RequestID: RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) PutFeedbackThreadReadState(
	writer http.ResponseWriter, request *http.Request, threadID contract.ThreadID,
) {
	if handler.discussions == nil {
		handler.Unimplemented.PutFeedbackThreadReadState(writer, request, threadID)
		return
	}
	principal, scope, err := handler.authorizeDiscussionResource(request, session.ResourceKindThread,
		threadID.String(), auth.PermissionRead)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	body, err := readBoundedBody(request.Body, maximumDiscussionMetadataBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	object, err := decodeJSONObject(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	if err := rejectUnknownJSONFields(object, "readThroughMessageId"); err != nil {
		WriteError(writer, request, err)
		return
	}
	messageID, err := requiredString(object, "readThroughMessageId")
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	err = handler.discussions.MarkThreadRead(request.Context(), discussion.MarkThreadReadInput{
		Scope: scope, ThreadID: threadID.String(), ReadThroughMessageID: messageID, Principal: principal,
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (handler *APIHandler) GetFeedbackEvidence(
	writer http.ResponseWriter,
	request *http.Request,
	threadID contract.ThreadID,
	params contract.GetFeedbackEvidenceParams,
) {
	if handler.evidence == nil {
		handler.Unimplemented.GetFeedbackEvidence(writer, request, threadID, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	download, err := handler.evidence.Download(
		request.Context(), principal, threadID.String(), RequestIDFromContext(request.Context()),
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	var requestedRange *string
	if params.Range != nil {
		value := string(*params.Range)
		requestedRange = &value
	}
	response, err := evidence.PrepareHTTPDownload(download, requestedRange)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	for name, values := range response.Header {
		for _, value := range values {
			writer.Header().Add(name, value)
		}
	}
	writer.WriteHeader(response.Status)
	_, _ = writer.Write(response.Body)
}

func (handler *APIHandler) authorizeDiscussionResource(
	request *http.Request,
	kind string,
	resourceID string,
	permission auth.Permission,
) (auth.Principal, auth.ResourceScope, error) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	if handler.scopeResolver == nil || handler.authorizer == nil || handler.auditor == nil {
		return auth.Principal{}, auth.ResourceScope{}, errors.New("discussion authorization dependencyが未設定です")
	}
	scope, err := handler.scopeResolver.ResolveResourceScope(
		request.Context(), principal.UserID, kind, resourceID,
	)
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	WithLogFields(request.Context(), LogFields{
		Tenant: scope.TenantKey, Application: scope.ApplicationKey,
		Environment: scope.EnvironmentKey, Workspace: scope.ExternalWorkspaceKey,
	})
	if _, err := handler.authorizer.Authorize(request.Context(), auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: permission,
		HideExistence: true, RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	if err := handler.auditor.RecordAudit(request.Context(), usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(permission),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed",
		RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, fmt.Errorf("discussion認可監査を記録できません: %w", err)
	}
	return principal, scope, nil
}

func (handler *APIHandler) authorizeDiscussionWorkspace(
	request *http.Request,
	applicationKey, environmentKey, externalWorkspaceKey string,
	permission auth.Permission,
) (auth.Principal, auth.ResourceScope, error) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	if handler.scopeResolver == nil || handler.authorizer == nil || handler.auditor == nil {
		return auth.Principal{}, auth.ResourceScope{}, errors.New("discussion authorization dependencyが未設定です")
	}
	if err := ValidateApplicationKey(applicationKey); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	environmentKey, err = ValidateKey(environmentKey, "environmentKey", 100)
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	externalWorkspaceKey, err = ValidateKey(externalWorkspaceKey, "externalWorkspaceKey", 200)
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	scope, err := handler.scopeResolver.ResolveWorkspaceScope(request.Context(), principal.UserID,
		applicationKey, externalWorkspaceKey, environmentKey)
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	if _, err := handler.authorizer.Authorize(request.Context(), auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: permission, HideExistence: true,
		RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	WithLogFields(request.Context(), LogFields{
		Tenant: scope.TenantKey, Application: scope.ApplicationKey,
		Environment: scope.EnvironmentKey, Workspace: scope.ExternalWorkspaceKey,
	})
	if err := handler.auditor.RecordAudit(request.Context(), usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(permission),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed",
		RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, fmt.Errorf("discussion認可監査を記録できません: %w", err)
	}
	return principal, scope, nil
}

func (handler *APIHandler) enforceDiscussionRateLimit(
	request *http.Request,
	principal auth.Principal,
	scope auth.ResourceScope,
) error {
	if handler.rateLimiter == nil {
		return errors.New("write rate limiterが未設定です")
	}
	return handler.rateLimiter.EnforceWriteRateLimit(request.Context(), discussion.RateLimitInput{
		Scope: scope, Principal: principal, RemoteAddress: remoteHost(request.RemoteAddr),
		PrincipalLimitPerMinute: handler.discussionSettings.PrincipalLimitPerMinute,
		TenantLimitPerMinute:    handler.discussionSettings.TenantLimitPerMinute,
		IPLimitPerMinute:        handler.discussionSettings.IPLimitPerMinute,
		RequestID:               RequestIDFromContext(request.Context()),
	})
}

func remoteHost(address string) string {
	host, _, err := net.SplitHostPort(address)
	if err == nil && host != "" {
		return host
	}
	return strings.Trim(address, "[]")
}

func (handler *APIHandler) maximumThreadRequestBytes() int64 {
	maximum := handler.discussionSettings.EvidenceMaximumBytes
	if maximum > (1<<62)-maximumDiscussionMetadataBytes {
		return 1 << 62
	}
	// Base64は最大4/3だが、overflowを避けた保守的な2倍上限とする。
	return maximum*2 + maximumDiscussionMetadataBytes
}

type threadCreateWire struct {
	Location        json.RawMessage `json:"location"`
	Target          json.RawMessage `json:"target"`
	PerspectiveCode *string         `json:"perspectiveCode"`
	Body            *string         `json:"body"`
	ParticipantName *string         `json:"participantName"`
	Evidence        json.RawMessage `json:"evidence"`
}

type evidenceCreateWire struct {
	ContentType    *string  `json:"contentType"`
	DataBase64     *string  `json:"dataBase64"`
	ViewportWidth  *int     `json:"viewportWidth"`
	ViewportHeight *int     `json:"viewportHeight"`
	PixelRatio     *float64 `json:"pixelRatio"`
	CapturedAt     *string  `json:"capturedAt"`
}

func (handler *APIHandler) decodeThreadCreate(body []byte) (discussion.ThreadCreateRequest, error) {
	var raw map[string]json.RawMessage
	if err := decodeStrict(body, &raw); err != nil {
		return discussion.ThreadCreateRequest{}, invalidJSON(err)
	}
	if raw == nil {
		return discussion.ThreadCreateRequest{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	var wire threadCreateWire
	if err := decodeStrict(body, &wire); err != nil {
		return discussion.ThreadCreateRequest{}, invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	for _, key := range []string{"location", "target", "perspectiveCode", "body"} {
		value, exists := raw[key]
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return discussion.ThreadCreateRequest{}, invalid("request.invalid", "%sがありません", key)
		}
	}
	if wire.PerspectiveCode == nil || wire.Body == nil {
		return discussion.ThreadCreateRequest{}, invalid("request.invalid", "request bodyの必須fieldが不正です")
	}
	result := discussion.ThreadCreateRequest{
		Location:        append(json.RawMessage(nil), wire.Location...),
		Target:          append(json.RawMessage(nil), wire.Target...),
		PerspectiveCode: *wire.PerspectiveCode, Body: *wire.Body, ParticipantName: wire.ParticipantName,
	}
	if value, exists := raw["evidence"]; exists && !bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		var attachment evidenceCreateWire
		if err := decodeStrict(value, &attachment); err != nil {
			return discussion.ThreadCreateRequest{}, invalid("request.invalid", "evidenceが不正です: %v", err)
		}
		if attachment.ContentType == nil || attachment.DataBase64 == nil || attachment.ViewportWidth == nil ||
			attachment.ViewportHeight == nil || attachment.PixelRatio == nil || attachment.CapturedAt == nil {
			return discussion.ThreadCreateRequest{}, invalid("request.invalid", "evidenceの必須fieldがありません")
		}
		data, err := evidence.DecodeBase64(*attachment.DataBase64, handler.discussionSettings.EvidenceMaximumBytes)
		if err != nil {
			return discussion.ThreadCreateRequest{}, err
		}
		capturedAt, err := time.Parse(time.RFC3339Nano, *attachment.CapturedAt)
		if err != nil {
			return discussion.ThreadCreateRequest{}, invalid("request.invalid", "evidence.capturedAtが不正です")
		}
		result.Evidence = &evidence.Input{
			ContentType: *attachment.ContentType, Data: data,
			ViewportWidth: *attachment.ViewportWidth, ViewportHeight: *attachment.ViewportHeight,
			PixelRatio: *attachment.PixelRatio, CapturedAt: capturedAt,
		}
	}
	return result, nil
}

type messageWire struct {
	Body            *string `json:"body"`
	ParticipantName *string `json:"participantName"`
}

func decodeMessageCreate(body []byte) (discussion.MessageCreateRequest, error) {
	wire, err := decodeMessageWire(body)
	if err != nil {
		return discussion.MessageCreateRequest{}, err
	}
	return discussion.MessageCreateRequest{Body: *wire.Body, ParticipantName: wire.ParticipantName}, nil
}

func decodeMessagePatch(body []byte) (discussion.MessagePatchRequest, error) {
	wire, err := decodeMessageWire(body)
	if err != nil {
		return discussion.MessagePatchRequest{}, err
	}
	return discussion.MessagePatchRequest{Body: *wire.Body, ParticipantName: wire.ParticipantName}, nil
}

func decodeMessageWire(body []byte) (messageWire, error) {
	var raw map[string]json.RawMessage
	if err := decodeStrict(body, &raw); err != nil {
		return messageWire{}, invalidJSON(err)
	}
	if raw == nil {
		return messageWire{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	var wire messageWire
	if err := decodeStrict(body, &wire); err != nil {
		return messageWire{}, invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	value, exists := raw["body"]
	if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || wire.Body == nil {
		return messageWire{}, invalid("request.invalid", "bodyがありません")
	}
	return wire, nil
}

func decodeThreadStatusPatch(body []byte) (string, error) {
	var raw map[string]json.RawMessage
	if err := decodeStrict(body, &raw); err != nil {
		return "", invalidJSON(err)
	}
	if raw == nil {
		return "", invalidJSON(errors.New("JSON objectを指定してください"))
	}
	var wire struct {
		Status *string `json:"status"`
	}
	if err := decodeStrict(body, &wire); err != nil {
		return "", invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	value, exists := raw["status"]
	if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || wire.Status == nil {
		return "", invalid("request.invalid", "statusがありません")
	}
	return *wire.Status, nil
}

func decodeThreadTriagePatch(body []byte) (discussion.ThreadTriagePatch, error) {
	object, err := decodeJSONObject(body)
	if err != nil {
		return discussion.ThreadTriagePatch{}, err
	}
	if err := rejectUnknownJSONFields(object, "assigneeUserId", "priority", "labels"); err != nil {
		return discussion.ThreadTriagePatch{}, err
	}
	var patch discussion.ThreadTriagePatch
	if raw, exists := object["assigneeUserId"]; exists {
		patch.AssigneeSet = true
		patch.AssigneeUserID, err = decodeNullablePatchString(raw, "assigneeUserId")
		if err != nil {
			return discussion.ThreadTriagePatch{}, err
		}
	}
	if raw, exists := object["priority"]; exists {
		patch.PrioritySet = true
		patch.Priority, err = decodeNullablePatchString(raw, "priority")
		if err != nil {
			return discussion.ThreadTriagePatch{}, err
		}
	}
	if raw, exists := object["labels"]; exists {
		patch.LabelsSet = true
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return discussion.ThreadTriagePatch{}, invalid("request.invalid", "labelsは配列で指定してください")
		}
		if err := json.Unmarshal(raw, &patch.Labels); err != nil {
			return discussion.ThreadTriagePatch{}, invalid("request.invalid", "labelsは文字列配列で指定してください")
		}
	}
	return patch, nil
}

func mapDiscussionError(err error) error {
	var domainError *discussion.Error
	if !errors.As(err, &domainError) {
		return nil
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, discussion.ErrInvalidInput):
		status = http.StatusBadRequest
	case errors.Is(err, discussion.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, discussion.ErrConflict):
		status = http.StatusConflict
	case errors.Is(err, discussion.ErrVersionMismatch):
		status = http.StatusPreconditionFailed
	case errors.Is(err, discussion.ErrForbidden):
		status = http.StatusForbidden
	case errors.Is(err, discussion.ErrRateLimited):
		status = http.StatusTooManyRequests
	case errors.Is(err, discussion.ErrPayloadTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, discussion.ErrStorageUnavailable), errors.Is(err, discussion.ErrCommitUnknown):
		status = http.StatusServiceUnavailable
	}
	result := NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
	if status == http.StatusTooManyRequests {
		retryAfter := domainError.RetryAfterSeconds
		if retryAfter <= 0 {
			retryAfter = 60
		}
		result.Header.Set("Retry-After", strconv.Itoa(retryAfter))
	}
	return result
}

func mapEvidenceError(err error) error {
	var domainError *evidence.Error
	if !errors.As(err, &domainError) {
		return nil
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, evidence.ErrInvalidInput):
		status = http.StatusBadRequest
	case errors.Is(err, evidence.ErrTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, evidence.ErrQuotaExceeded):
		status = http.StatusTooManyRequests
	case errors.Is(err, evidence.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, evidence.ErrRangeNotSatisfiable):
		status = http.StatusRequestedRangeNotSatisfiable
	case errors.Is(err, evidence.ErrStorageUnavailable), errors.Is(err, evidence.ErrIntegrity):
		status = http.StatusServiceUnavailable
	}
	result := NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
	if status == http.StatusTooManyRequests {
		result.Header.Set("Retry-After", "60")
	}
	return result
}
