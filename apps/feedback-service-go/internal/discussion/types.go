// Package discussion はthread/messageのv1業務契約を提供する。
package discussion

import (
	"encoding/json"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/evidence"
)

type Participant struct {
	PrincipalID     string  `json:"principalId"`
	DisplayName     *string `json:"displayName"`
	ParticipantName *string `json:"participantName"`
}

type Assignee struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
}

type ReactionSummary struct {
	Reaction    string `json:"reaction"`
	Count       int    `json:"count"`
	ReactedByMe bool   `json:"reactedByMe"`
}

type Message struct {
	ID        string            `json:"id"`
	ThreadID  string            `json:"threadId"`
	Author    Participant       `json:"author"`
	Body      string            `json:"body"`
	CreatedAt string            `json:"createdAt"`
	EditedAt  *string           `json:"editedAt"`
	Version   int               `json:"version"`
	Reactions []ReactionSummary `json:"reactions,omitempty"`
}

type MessageVersion struct {
	ID        string      `json:"id"`
	ThreadID  string      `json:"threadId"`
	Author    Participant `json:"author"`
	Body      string      `json:"body"`
	CreatedAt string      `json:"createdAt"`
	EditedAt  *string     `json:"editedAt"`
	Version   int         `json:"version"`
	Current   bool        `json:"current"`
}

type Thread struct {
	ID                string          `json:"id"`
	SessionID         string          `json:"sessionId"`
	DisplayNumber     int             `json:"displayNumber"`
	Location          json.RawMessage `json:"location"`
	Target            json.RawMessage `json:"target"`
	PerspectiveCode   string          `json:"perspectiveCode"`
	Status            string          `json:"status"`
	Reporter          Participant     `json:"reporter"`
	EvidenceAvailable bool            `json:"evidenceAvailable"`
	Assignee          *Assignee       `json:"assignee,omitempty"`
	Priority          *string         `json:"priority,omitempty"`
	Labels            []string        `json:"labels,omitempty"`
	Messages          []Message       `json:"messages"`
	CreatedAt         string          `json:"createdAt"`
	UpdatedAt         string          `json:"updatedAt"`
	Version           int             `json:"version"`
}

type ThreadPage struct {
	Items      []Thread `json:"items"`
	NextCursor *string  `json:"nextCursor"`
	TotalCount int64    `json:"totalCount"`
}

type Mutation[T any] struct {
	Value           T
	Replay          bool
	EvidenceCleanup CleanupDisposition
}

type CleanupDisposition string

const (
	CleanupNone               CleanupDisposition = "none"
	CleanupDiscardNow         CleanupDisposition = "discard-now"
	CleanupDeferToOrphanSweep CleanupDisposition = "defer-to-orphan-sweep"
)

type ThreadCreateRequest struct {
	Location        json.RawMessage
	Target          json.RawMessage
	PerspectiveCode string
	Body            string
	ParticipantName *string
	Evidence        *evidence.Input
}

type MessageCreateRequest struct {
	Body            string
	ParticipantName *string
}

type MessagePatchRequest struct {
	Body            string
	ParticipantName *string
}

type ListThreadsInput struct {
	SessionID         string
	Status            *string
	Sort              string
	PerspectiveCode   *string
	AssigneeUserID    *string
	Priority          *string
	Label             *string
	EvidenceAvailable *bool
	Query             *string
	ViewerUserID      string
	Limit             int
	Offset            int
}

type CreateThreadInput struct {
	Scope           auth.ResourceScope
	SessionID       string
	ThreadID        string
	Principal       auth.Principal
	Request         ThreadCreateRequest
	Evidence        *evidence.Attachment
	EvidenceMaximum int
	IdempotencyKey  string
	RequestHash     string
	RequestID       string
}

type CreateMessageInput struct {
	Scope          auth.ResourceScope
	ThreadID       string
	Principal      auth.Principal
	Request        MessageCreateRequest
	IdempotencyKey string
	RequestHash    string
	RequestID      string
}

type PatchMessageInput struct {
	Scope           auth.ResourceScope
	MessageID       string
	Principal       auth.Principal
	ExpectedVersion int
	Request         MessagePatchRequest
	RequestID       string
}

type PatchThreadStatusInput struct {
	Scope           auth.ResourceScope
	ThreadID        string
	Principal       auth.Principal
	ExpectedVersion int
	Status          string
	RequestID       string
}

type ThreadTriagePatch struct {
	AssigneeSet    bool
	AssigneeUserID *string
	PrioritySet    bool
	Priority       *string
	LabelsSet      bool
	Labels         []string
}

type PatchThreadTriageInput struct {
	Scope           auth.ResourceScope
	ThreadID        string
	Principal       auth.Principal
	ExpectedVersion int
	Patch           ThreadTriagePatch
	RequestID       string
}

type ReactionInput struct {
	Scope     auth.ResourceScope
	MessageID string
	Principal auth.Principal
	Reaction  string
	Add       bool
	RequestID string
}

type UnreadReplyThread struct {
	ThreadID        string `json:"threadId"`
	Count           int    `json:"count"`
	LatestMessageID string `json:"latestMessageId"`
	LatestAt        string `json:"latestAt"`
}

type UnreadReplySummary struct {
	TotalCount int                 `json:"totalCount"`
	Threads    []UnreadReplyThread `json:"threads"`
}

type UnreadRepliesInput struct {
	Scope     auth.ResourceScope
	Principal auth.Principal
}

type MarkThreadReadInput struct {
	Scope                auth.ResourceScope
	ThreadID             string
	ReadThroughMessageID string
	Principal            auth.Principal
}

type RateLimitInput struct {
	Scope                   auth.ResourceScope
	Principal               auth.Principal
	RemoteAddress           string
	PrincipalLimitPerMinute int
	TenantLimitPerMinute    int
	IPLimitPerMinute        int
	RequestID               string
}
