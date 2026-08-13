package bootstrap

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
)

const (
	documentSchemaVersion  = "1"
	maximumDocumentBytes   = 4 * 1024 * 1024
	maximumDocumentEntries = 1_000
)

// Document はCI/CDから同期するversioned installation manifestである。
// entryはworkspace membership単位であり、同じresourceは冪等upsertされる。
type Document struct {
	SchemaVersion string  `json:"schemaVersion"`
	Entries       []Input `json:"entries"`
}

// DecodeDocument は未知fieldと過大入力を拒否してinstallation manifestを読む。
func DecodeDocument(reader io.Reader) (Document, error) {
	if reader == nil {
		return Document{}, errors.New("installation manifest readerが未設定です")
	}
	body, err := io.ReadAll(io.LimitReader(reader, maximumDocumentBytes+1))
	if err != nil {
		return Document{}, fmt.Errorf("installation manifestを読めません: %w", err)
	}
	if len(body) > maximumDocumentBytes {
		return Document{}, fmt.Errorf("installation manifestは%d bytes以下にしてください", maximumDocumentBytes)
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("installation manifestが不正です: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Document{}, errors.New("installation manifestの後に余分なJSONがあります")
		}
		return Document{}, fmt.Errorf("installation manifestの終端が不正です: %w", err)
	}
	if _, err := validateDocument(document); err != nil {
		return Document{}, err
	}
	return document, nil
}

func validateDocument(document Document) ([]validatedInput, error) {
	if document.SchemaVersion != documentSchemaVersion {
		return nil, fmt.Errorf("schemaVersionは%qを指定してください", documentSchemaVersion)
	}
	if len(document.Entries) == 0 || len(document.Entries) > maximumDocumentEntries {
		return nil, fmt.Errorf("entriesは1件以上%d件以下にしてください", maximumDocumentEntries)
	}
	validated := make([]validatedInput, 0, len(document.Entries))
	applicationTenants := make(map[string]string)
	tenantNames := make(map[string]string)
	applicationNames := make(map[string]string)
	environments := make(map[string]string)
	workspaces := make(map[string]string)
	principals := make(map[string]string)
	applicationMemberships := make(map[string]string)
	memberships := make(map[string]string)
	for index, input := range document.Entries {
		entry, err := validateInput(input)
		if err != nil {
			return nil, fmt.Errorf("entries[%d]が不正です: %w", index, err)
		}
		if tenant, exists := applicationTenants[entry.applicationKey]; exists && tenant != entry.tenantKey {
			return nil, fmt.Errorf(
				"applicationKey %qはService全体で一意です: tenant %qと%qへ重複指定できません",
				entry.applicationKey, tenant, entry.tenantKey,
			)
		}
		applicationTenants[entry.applicationKey] = entry.tenantKey
		if err := requireConsistent(
			tenantNames, entry.tenantKey, entry.tenantDisplayName, "tenant", index,
		); err != nil {
			return nil, err
		}
		if err := requireConsistent(
			applicationNames, entry.applicationKey, entry.applicationDisplayName, "application", index,
		); err != nil {
			return nil, err
		}
		origins := slices.Clone(entry.allowedOrigins)
		slices.Sort(origins)
		environmentKey := entry.applicationKey + "\x00" + entry.environmentKey
		environmentValue := entry.environmentBaseURL + "\x00" + strings.Join(origins, "\x00")
		if err := requireConsistent(environments, environmentKey, environmentValue, "environment", index); err != nil {
			return nil, err
		}
		workspaceKey := entry.applicationKey + "\x00" + entry.externalWorkspaceKey
		workspaceValue := entry.tenantKey + "\x00" + entry.workspaceDisplayName
		if err := requireConsistent(workspaces, workspaceKey, workspaceValue, "workspace", index); err != nil {
			return nil, err
		}
		principalKey := entry.issuer + "\x00" + entry.subject
		principalValue := optionalValue(entry.email) + "\x00" + optionalValue(entry.displayName)
		if err := requireConsistent(principals, principalKey, principalValue, "principal", index); err != nil {
			return nil, err
		}
		permissionValue := strings.Join(entry.permissions, "\x00")
		applicationMembershipKey := entry.applicationKey + "\x00" + principalKey
		if err := requireConsistent(
			applicationMemberships, applicationMembershipKey, permissionValue, "application membership", index,
		); err != nil {
			return nil, err
		}
		membershipKey := workspaceKey + "\x00" + principalKey
		if err := requireConsistent(
			memberships, membershipKey, permissionValue, "workspace membership", index,
		); err != nil {
			return nil, err
		}
		validated = append(validated, entry)
	}
	return validated, nil
}

func optionalValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func requireConsistent(values map[string]string, key string, value string, resource string, index int) error {
	if previous, exists := values[key]; exists && previous != value {
		return fmt.Errorf("entries[%d]の%s定義が同じkeyの別entryと一致しません", index, resource)
	}
	values[key] = value
	return nil
}
