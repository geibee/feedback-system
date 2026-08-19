package discussion

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/evidence"
)

type Store interface {
	ListThreads(context.Context, ListThreadsInput) (ThreadPage, error)
	GetThread(context.Context, string, string) (Thread, error)
	CreateThread(context.Context, CreateThreadInput) (Mutation[Thread], error)
	GetThreadDeepLink(context.Context, string) (string, error)
	CreateMessage(context.Context, CreateMessageInput) (Mutation[Message], error)
	PatchMessage(context.Context, PatchMessageInput) (Message, error)
	ListMessageVersions(context.Context, string) ([]MessageVersion, error)
	PatchThreadStatus(context.Context, PatchThreadStatusInput) (Thread, error)
	PatchThreadTriage(context.Context, PatchThreadTriageInput) (Thread, error)
	SetMessageReaction(context.Context, ReactionInput) (Message, error)
	ListUnreadReplies(context.Context, UnreadRepliesInput) (UnreadReplySummary, error)
	MarkThreadRead(context.Context, MarkThreadReadInput) error
	EnforceWriteRateLimit(context.Context, RateLimitInput) ([]string, error)
}

type Service struct {
	store            Store
	evidenceStager   evidence.Stager
	evidenceMaximum  int
	newID            func() string
	onCleanupFailure func(context.Context, evidence.Attachment, error)
}

type Option func(*Service)

func WithIDGenerator(generator func() string) Option {
	return func(service *Service) { service.newID = generator }
}

func WithEvidenceCleanupObserver(observer func(context.Context, evidence.Attachment, error)) Option {
	return func(service *Service) { service.onCleanupFailure = observer }
}

func NewService(store Store, evidenceStager evidence.Stager, evidenceMaximum int, options ...Option) (*Service, error) {
	if store == nil {
		return nil, errors.New("discussion storeが未設定です")
	}
	if evidenceMaximum <= 0 {
		return nil, errors.New("evidence件数上限は正数で指定してください")
	}
	service := &Service{
		store: store, evidenceStager: evidenceStager, evidenceMaximum: evidenceMaximum,
		newID:            uuid.NewString,
		onCleanupFailure: func(context.Context, evidence.Attachment, error) {},
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	if service.newID == nil || service.onCleanupFailure == nil {
		return nil, errors.New("discussion optionが不正です")
	}
	return service, nil
}

func (service *Service) ListThreads(ctx context.Context, input ListThreadsInput) (ThreadPage, error) {
	if err := validateUUID(input.SessionID, "sessionId"); err != nil {
		return ThreadPage{}, err
	}
	if input.Status != nil && *input.Status != "open" && *input.Status != "resolved" {
		return ThreadPage{}, invalid("request.invalid", "thread statusが不正です")
	}
	if input.Sort == "" {
		input.Sort = "updated_desc"
	}
	if input.Sort != "created_desc" && input.Sort != "created_asc" && input.Sort != "updated_desc" {
		return ThreadPage{}, invalid("request.invalid", "thread sortが不正です")
	}
	if input.PerspectiveCode != nil {
		if _, err := validateText(*input.PerspectiveCode, "perspectiveCode", 100); err != nil {
			return ThreadPage{}, err
		}
	}
	if input.AssigneeUserID != nil {
		if err := validateUUID(*input.AssigneeUserID, "assigneeUserId"); err != nil {
			return ThreadPage{}, err
		}
	}
	if input.Priority != nil && !validPriority(*input.Priority) {
		return ThreadPage{}, invalid("request.invalid", "priorityが不正です")
	}
	if input.Label != nil {
		if _, err := validateText(*input.Label, "label", 50); err != nil {
			return ThreadPage{}, err
		}
	}
	if input.Query != nil {
		if _, err := validateText(*input.Query, "q", 200); err != nil {
			return ThreadPage{}, err
		}
	}
	if input.Limit < 1 || input.Limit > 200 || input.Offset < 0 {
		return ThreadPage{}, invalid("request.invalid", "paginationが不正です")
	}
	return service.store.ListThreads(ctx, input)
}

func (service *Service) PatchThreadTriage(ctx context.Context, input PatchThreadTriageInput) (Thread, error) {
	if err := validateUUID(input.ThreadID, "threadId"); err != nil {
		return Thread{}, err
	}
	if input.ExpectedVersion <= 0 {
		return Thread{}, invalid("etag.invalid", "If-Matchが不正です")
	}
	if err := validateMutationActor(input.Scope, input.Principal.Subject); err != nil {
		return Thread{}, err
	}
	if err := validateUUID(input.Principal.UserID, "principal.userId"); err != nil {
		return Thread{}, err
	}
	if !input.Patch.AssigneeSet && !input.Patch.PrioritySet && !input.Patch.LabelsSet {
		return Thread{}, invalid("request.invalid", "triage更新項目がありません")
	}
	if input.Patch.AssigneeUserID != nil {
		if err := validateUUID(*input.Patch.AssigneeUserID, "assigneeUserId"); err != nil {
			return Thread{}, err
		}
	}
	if input.Patch.Priority != nil && !validPriority(*input.Patch.Priority) {
		return Thread{}, invalid("request.invalid", "priorityが不正です")
	}
	if input.Patch.LabelsSet {
		if len(input.Patch.Labels) > 10 {
			return Thread{}, invalid("request.invalid", "labelは10件以下です")
		}
		seen := make(map[string]struct{}, len(input.Patch.Labels))
		labels := make([]string, 0, len(input.Patch.Labels))
		for _, raw := range input.Patch.Labels {
			label, err := validateText(raw, "label", 50)
			if err != nil {
				return Thread{}, err
			}
			if _, exists := seen[label]; exists {
				continue
			}
			seen[label] = struct{}{}
			labels = append(labels, label)
		}
		input.Patch.Labels = labels
	}
	return service.store.PatchThreadTriage(ctx, input)
}

func (service *Service) SetMessageReaction(ctx context.Context, input ReactionInput) (Message, error) {
	if err := validateUUID(input.MessageID, "messageId"); err != nil {
		return Message{}, err
	}
	if err := validateMutationActor(input.Scope, input.Principal.Subject); err != nil {
		return Message{}, err
	}
	if err := validateUUID(input.Principal.UserID, "principal.userId"); err != nil {
		return Message{}, err
	}
	if !validReaction(input.Reaction) {
		return Message{}, invalid("request.invalid", "reactionが不正です")
	}
	return service.store.SetMessageReaction(ctx, input)
}

func (service *Service) ListUnreadReplies(ctx context.Context, input UnreadRepliesInput) (UnreadReplySummary, error) {
	if err := validateMutationActor(input.Scope, input.Principal.Subject); err != nil {
		return UnreadReplySummary{}, err
	}
	if err := validateUUID(input.Principal.UserID, "principal.userId"); err != nil {
		return UnreadReplySummary{}, err
	}
	return service.store.ListUnreadReplies(ctx, input)
}

func (service *Service) MarkThreadRead(ctx context.Context, input MarkThreadReadInput) error {
	if err := validateUUID(input.ThreadID, "threadId"); err != nil {
		return err
	}
	if err := validateUUID(input.ReadThroughMessageID, "readThroughMessageId"); err != nil {
		return err
	}
	if err := validateMutationActor(input.Scope, input.Principal.Subject); err != nil {
		return err
	}
	if err := validateUUID(input.Principal.UserID, "principal.userId"); err != nil {
		return err
	}
	return service.store.MarkThreadRead(ctx, input)
}

func validPriority(value string) bool {
	return value == "critical" || value == "high" || value == "medium" || value == "low"
}

func validReaction(value string) bool {
	return value == "thumbs_up" || value == "check" || value == "eyes" || value == "question"
}

func (service *Service) GetThread(ctx context.Context, threadID string) (Thread, error) {
	return service.GetThreadForViewer(ctx, threadID, "")
}

func (service *Service) GetThreadForViewer(ctx context.Context, threadID, viewerUserID string) (Thread, error) {
	if err := validateUUID(threadID, "threadId"); err != nil {
		return Thread{}, err
	}
	if viewerUserID != "" {
		if err := validateUUID(viewerUserID, "viewerUserId"); err != nil {
			return Thread{}, err
		}
	}
	return service.store.GetThread(ctx, threadID, viewerUserID)
}

func (service *Service) CreateThread(ctx context.Context, input CreateThreadInput) (Mutation[Thread], error) {
	if err := validateCreateThread(&input); err != nil {
		return Mutation[Thread]{}, err
	}
	input.ThreadID = service.newID()
	if err := validateUUID(input.ThreadID, "threadId"); err != nil {
		return Mutation[Thread]{}, fmt.Errorf("thread ID generator: %w", err)
	}

	var staged *evidence.Attachment
	if input.Request.Evidence != nil {
		if service.evidenceStager == nil {
			return Mutation[Thread]{}, &Error{
				Kind: ErrStorageUnavailable, Code: "evidence.storage_unavailable",
				Detail: "evidence storageへ保存できません",
			}
		}
		attachment, err := service.evidenceStager.Stage(ctx, input.Scope, input.ThreadID, *input.Request.Evidence)
		if err != nil {
			return Mutation[Thread]{}, mapEvidenceError(err)
		}
		staged = &attachment
		input.Evidence = staged
		input.EvidenceMaximum = service.evidenceMaximum
	}

	result, err := service.store.CreateThread(ctx, input)
	if staged != nil && result.EvidenceCleanup == CleanupDiscardNow {
		if deleteErr := service.evidenceStager.Discard(context.WithoutCancel(ctx), *staged); deleteErr != nil {
			service.onCleanupFailure(context.WithoutCancel(ctx), *staged, deleteErr)
		}
	}
	if staged != nil && result.EvidenceCleanup == CleanupDeferToOrphanSweep {
		service.onCleanupFailure(context.WithoutCancel(ctx), *staged, ErrCommitUnknown)
	}
	if err != nil {
		return result, mapStoreError(err)
	}
	return result, nil
}

func mapStoreError(err error) error {
	var evidenceError *evidence.Error
	if errors.As(err, &evidenceError) {
		return mapEvidenceError(err)
	}
	return err
}

func mapEvidenceError(err error) error {
	if err == nil {
		return nil
	}
	var domainError *Error
	if errors.As(err, &domainError) {
		return err
	}
	var evidenceError *evidence.Error
	if errors.As(err, &evidenceError) {
		kind := ErrStorageUnavailable
		switch {
		case errors.Is(err, evidence.ErrInvalidInput):
			kind = ErrInvalidInput
		case errors.Is(err, evidence.ErrTooLarge):
			kind = ErrPayloadTooLarge
		case errors.Is(err, evidence.ErrQuotaExceeded):
			kind = ErrRateLimited
		}
		retryAfter := 0
		if errors.Is(err, evidence.ErrQuotaExceeded) {
			retryAfter = 60
		}
		return &Error{
			Kind: kind, Code: evidenceError.Code, Detail: evidenceError.Detail,
			RetryAfterSeconds: retryAfter,
		}
	}
	return &Error{
		Kind: ErrStorageUnavailable, Code: "evidence.storage_unavailable",
		Detail: "evidence storageへ保存できません",
	}
}

func (service *Service) GetThreadDeepLink(ctx context.Context, threadID string) (string, error) {
	if err := validateUUID(threadID, "threadId"); err != nil {
		return "", err
	}
	return service.store.GetThreadDeepLink(ctx, threadID)
}

func (service *Service) CreateMessage(ctx context.Context, input CreateMessageInput) (Mutation[Message], error) {
	if err := validateUUID(input.ThreadID, "threadId"); err != nil {
		return Mutation[Message]{}, err
	}
	if err := validateMutationIdentity(input.Scope, input.Principal.Subject, input.IdempotencyKey, input.RequestHash); err != nil {
		return Mutation[Message]{}, err
	}
	_, err := validateBody(input.Request.Body)
	if err != nil {
		return Mutation[Message]{}, err
	}
	if err := validateParticipantName(input.Request.ParticipantName); err != nil {
		return Mutation[Message]{}, err
	}
	return service.store.CreateMessage(ctx, input)
}

func (service *Service) PatchMessage(ctx context.Context, input PatchMessageInput) (Message, error) {
	if err := validateUUID(input.MessageID, "messageId"); err != nil {
		return Message{}, err
	}
	if input.ExpectedVersion <= 0 {
		return Message{}, invalid("etag.invalid", "If-Matchが不正です")
	}
	if err := validateMutationActor(input.Scope, input.Principal.Subject); err != nil {
		return Message{}, err
	}
	_, err := validateBody(input.Request.Body)
	if err != nil {
		return Message{}, err
	}
	if err := validateParticipantName(input.Request.ParticipantName); err != nil {
		return Message{}, err
	}
	return service.store.PatchMessage(ctx, input)
}

func (service *Service) ListMessageVersions(ctx context.Context, messageID string) ([]MessageVersion, error) {
	if err := validateUUID(messageID, "messageId"); err != nil {
		return nil, err
	}
	return service.store.ListMessageVersions(ctx, messageID)
}

func (service *Service) PatchThreadStatus(ctx context.Context, input PatchThreadStatusInput) (Thread, error) {
	if err := validateUUID(input.ThreadID, "threadId"); err != nil {
		return Thread{}, err
	}
	if input.ExpectedVersion <= 0 {
		return Thread{}, invalid("etag.invalid", "If-Matchが不正です")
	}
	if input.Status != "open" && input.Status != "resolved" {
		return Thread{}, invalid("request.invalid", "statusが不正です")
	}
	if err := validateMutationActor(input.Scope, input.Principal.Subject); err != nil {
		return Thread{}, err
	}
	return service.store.PatchThreadStatus(ctx, input)
}

func (service *Service) EnforceWriteRateLimit(ctx context.Context, input RateLimitInput) error {
	if err := validateRateLimitActor(input.Scope, input.Principal.Subject); err != nil {
		return err
	}
	if strings.TrimSpace(input.RemoteAddress) == "" {
		return invalid("request.invalid", "rate limit scopeが不正です")
	}
	if input.PrincipalLimitPerMinute <= 0 || input.TenantLimitPerMinute <= 0 || input.IPLimitPerMinute <= 0 {
		return invalid("request.invalid", "write rate limitは正数で指定してください")
	}
	exceeded, err := service.store.EnforceWriteRateLimit(ctx, input)
	if err != nil {
		return err
	}
	if len(exceeded) != 0 {
		return &Error{
			Kind: ErrRateLimited, Code: "rate_limit.exceeded", RetryAfterSeconds: 60,
			Detail: strings.Join(exceeded, ", ") + " write rate limitを超えました",
		}
	}
	return nil
}

func validateRateLimitActor(scope auth.ResourceScope, subject string) error {
	// 管理APIはenvironmentを持たないworkspace scopeでもwrite rate limitを共有する。
	if scope.TenantID == "" || scope.WorkspaceID == "" {
		return invalid("request.invalid", "rate limit scopeが不正です")
	}
	if strings.TrimSpace(subject) == "" {
		return invalid("request.invalid", "principal subjectがありません")
	}
	return nil
}

func validateCreateThread(input *CreateThreadInput) error {
	if err := validateUUID(input.SessionID, "sessionId"); err != nil {
		return err
	}
	if err := validateMutationIdentity(input.Scope, input.Principal.Subject, input.IdempotencyKey, input.RequestHash); err != nil {
		return err
	}
	if _, err := validateText(input.Request.PerspectiveCode, "perspectiveCode", 100); err != nil {
		return err
	}
	_, err := validateBody(input.Request.Body)
	if err != nil {
		return err
	}
	if err := validateParticipantName(input.Request.ParticipantName); err != nil {
		return err
	}
	if _, err := ValidateTarget(input.Request.Target); err != nil {
		return err
	}
	if len(input.Request.Location) == 0 || !jsonObject(input.Request.Location) {
		return invalid("request.invalid", "locationはobjectで指定してください")
	}
	return nil
}

func validateMutationIdentity(scope auth.ResourceScope, subject string, key string, requestHash string) error {
	if err := validateMutationActor(scope, subject); err != nil {
		return err
	}
	if utf16Length(key) < 16 || utf16Length(key) > 200 {
		return invalid("idempotency.required", "Idempotency-Keyは16文字以上200文字以下で指定してください")
	}
	if len(requestHash) != sha256.Size*2 || !isLowerHex(requestHash) {
		return invalid("request.invalid", "request hashが不正です")
	}
	return nil
}

func validateMutationActor(scope auth.ResourceScope, subject string) error {
	if scope.TenantID == "" || scope.ApplicationID == "" ||
		scope.EnvironmentID == "" || scope.WorkspaceID == "" {
		return invalid("request.invalid", "resource scopeが不正です")
	}
	if strings.TrimSpace(subject) == "" {
		return invalid("request.invalid", "principal subjectがありません")
	}
	return nil
}
