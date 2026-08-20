package discussion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
)

func validateBody(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" || utf16Length(raw) > 20000 {
		return "", invalid("request.invalid", "bodyは1文字以上20000文字以下で指定してください")
	}
	return strings.TrimSpace(raw), nil
}

func validateParticipantName(value *string) error {
	if value == nil {
		return nil
	}
	_, err := validateText(*value, "participantName", 100)
	return err
}

func validateText(raw string, name string, maximum int) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || utf16Length(value) > maximum {
		return "", invalid("request.invalid", fmt.Sprintf("%sは1文字以上%d文字以下で指定してください", name, maximum))
	}
	return value, nil
}

func validateUUID(value string, name string) error {
	if _, err := uuid.Parse(value); err != nil {
		return invalid("request.invalid", name+"はUUIDで指定してください")
	}
	return nil
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func isLowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func jsonObject(raw json.RawMessage) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal(raw, &object) == nil && object != nil
}

func decodeObject(raw json.RawMessage, subject string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var object map[string]json.RawMessage
	if err := decoder.Decode(&object); err != nil || object == nil {
		return nil, invalid("request.invalid", subject+"はobjectで指定してください")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, invalid("request.invalid", subject+"が不正です")
	}
	return object, nil
}

func requireKeys(
	object map[string]json.RawMessage,
	required []string,
	optional []string,
	subject string,
) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
		if _, ok := object[key]; !ok {
			return invalid("request.invalid", subject+"のfieldが不足しています: "+key)
		}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range object {
		if _, ok := allowed[key]; !ok {
			return invalid("request.invalid", subject+"に未知のfieldがあります: "+key)
		}
	}
	return nil
}

func stringValue(object map[string]json.RawMessage, key string, subject string) (string, error) {
	var value string
	if err := json.Unmarshal(object[key], &value); err != nil {
		return "", invalid("request.invalid", subject+"."+key+"は文字列で指定してください")
	}
	return value, nil
}

func numberValue(object map[string]json.RawMessage, key string, minimum float64, maximum float64) error {
	decoder := json.NewDecoder(bytes.NewReader(object[key]))
	decoder.UseNumber()
	var raw any
	if err := decoder.Decode(&raw); err != nil {
		return invalid("request.invalid", "target."+key+"は数値で指定してください")
	}
	number, ok := raw.(json.Number)
	if !ok {
		return invalid("request.invalid", "target."+key+"は数値で指定してください")
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < minimum || value > maximum {
		return invalid("request.invalid", "target."+key+"が範囲外です")
	}
	return nil
}

var (
	customProviderPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,99}$`)
	metadataKeyPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]*$`)
)

func validateCustomMetadata(raw json.RawMessage) error {
	metadata, err := decodeObject(raw, "target.metadata")
	if err != nil {
		return err
	}
	if len(metadata) > 20 {
		return invalid("request.invalid", "target.metadataは20項目以下で指定してください")
	}
	for key, rawValue := range metadata {
		if len(key) > 64 || !metadataKeyPattern.MatchString(key) {
			return invalid("request.invalid", "target.metadataのkeyが不正です")
		}
		decoder := json.NewDecoder(bytes.NewReader(rawValue))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return invalid("request.invalid", "target.metadataの値が不正です")
		}
		switch typed := value.(type) {
		case nil, bool:
		case string:
			if utf8.RuneCountInString(typed) > 500 {
				return invalid("request.invalid", "target.metadataの文字列は500文字以下で指定してください")
			}
		case json.Number:
			number, numberErr := typed.Float64()
			if numberErr != nil || math.IsNaN(number) || math.IsInf(number, 0) {
				return invalid("request.invalid", "target.metadataの数値が不正です")
			}
		default:
			return invalid("request.invalid", "target.metadataにobjectまたはarrayは指定できません")
		}
	}
	return nil
}

// ValidateTarget はFeedbackTargetV1のoneOfと未知field拒否を検証する。
func ValidateTarget(raw json.RawMessage) (json.RawMessage, error) {
	target, err := decodeObject(raw, "target")
	if err != nil {
		return nil, err
	}
	schemaVersion, err := stringValue(target, "schemaVersion", "target")
	if err != nil || schemaVersion != "1" {
		return nil, invalid("request.invalid", "target.schemaVersionは1を指定してください")
	}
	kind, err := stringValue(target, "kind", "target")
	if err != nil {
		return nil, err
	}
	switch kind {
	case "ui-element":
		if err := requireKeys(
			target,
			[]string{"schemaVersion", "kind", "elementKey", "relativeX", "relativeY"},
			nil,
			"target",
		); err != nil {
			return nil, err
		}
		elementKey, err := stringValue(target, "elementKey", "target")
		if err != nil {
			return nil, err
		}
		if _, err := validateText(elementKey, "elementKey", 200); err != nil {
			return nil, err
		}
		if err := numberValue(target, "relativeX", 0, 1); err != nil {
			return nil, err
		}
		if err := numberValue(target, "relativeY", 0, 1); err != nil {
			return nil, err
		}
	case "screen-position":
		if err := requireKeys(
			target,
			[]string{"schemaVersion", "kind", "relativeX", "relativeY"}, nil, "target",
		); err != nil {
			return nil, err
		}
		if err := numberValue(target, "relativeX", 0, 1); err != nil {
			return nil, err
		}
		if err := numberValue(target, "relativeY", 0, 1); err != nil {
			return nil, err
		}
	case "map-feature":
		if err := requireKeys(
			target,
			[]string{"schemaVersion", "kind", "provider", "sourceKey", "featureKey", "longitude", "latitude"},
			[]string{"sourceLayer"}, "target",
		); err != nil {
			return nil, err
		}
		provider, err := stringValue(target, "provider", "target")
		if err != nil || provider != "maplibre" {
			return nil, invalid("request.invalid", "map-feature.providerはmaplibreを指定してください")
		}
		for _, key := range []string{"sourceKey", "featureKey"} {
			value, valueErr := stringValue(target, key, "target")
			if valueErr != nil {
				return nil, valueErr
			}
			if _, valueErr = validateText(value, key, 200); valueErr != nil {
				return nil, valueErr
			}
		}
		if _, ok := target["sourceLayer"]; ok {
			value, valueErr := stringValue(target, "sourceLayer", "target")
			if valueErr != nil {
				return nil, valueErr
			}
			if _, valueErr = validateText(value, "sourceLayer", 200); valueErr != nil {
				return nil, valueErr
			}
		}
		if err := numberValue(target, "longitude", -180, 180); err != nil {
			return nil, err
		}
		if err := numberValue(target, "latitude", -90, 90); err != nil {
			return nil, err
		}
	case "map-position":
		if err := requireKeys(
			target, []string{"schemaVersion", "kind", "longitude", "latitude"}, nil, "target",
		); err != nil {
			return nil, err
		}
		if err := numberValue(target, "longitude", -180, 180); err != nil {
			return nil, err
		}
		if err := numberValue(target, "latitude", -90, 90); err != nil {
			return nil, err
		}
	case "custom":
		if err := requireKeys(
			target,
			[]string{"schemaVersion", "kind", "provider", "targetKey", "fallbackRelativeX", "fallbackRelativeY"},
			[]string{"metadata"}, "target",
		); err != nil {
			return nil, err
		}
		provider, err := stringValue(target, "provider", "target")
		if err != nil || !customProviderPattern.MatchString(provider) {
			return nil, invalid("request.invalid", "custom.providerが不正です")
		}
		targetKey, err := stringValue(target, "targetKey", "target")
		if err != nil || utf8.RuneCountInString(targetKey) == 0 || utf8.RuneCountInString(targetKey) > 200 {
			return nil, invalid("request.invalid", "custom.targetKeyは1文字以上200文字以下で指定してください")
		}
		if err := numberValue(target, "fallbackRelativeX", 0, 1); err != nil {
			return nil, err
		}
		if err := numberValue(target, "fallbackRelativeY", 0, 1); err != nil {
			return nil, err
		}
		if metadata, ok := target["metadata"]; ok {
			if err := validateCustomMetadata(metadata); err != nil {
				return nil, err
			}
		}
	default:
		return nil, invalid("request.invalid", "target.kindが不正です")
	}
	return append(json.RawMessage(nil), raw...), nil
}
