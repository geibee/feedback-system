package discussion

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestValidateTarget(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "ui element", raw: `{"schemaVersion":"1","kind":"ui-element","elementKey":"save","relativeX":0,"relativeY":1}`},
		{name: "screen position", raw: `{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.25}`},
		{name: "map feature", raw: `{"schemaVersion":"1","kind":"map-feature","provider":"maplibre","sourceKey":"lots","featureKey":"3","longitude":139.7,"latitude":35.6}`},
		{name: "map position", raw: `{"schemaVersion":"1","kind":"map-position","longitude":-180,"latitude":90}`},
		{name: "custom", raw: `{"schemaVersion":"1","kind":"custom","provider":"com.example.threejs","targetKey":"model-42","fallbackRelativeX":0.25,"fallbackRelativeY":0.75,"metadata":{"layerName":"equipment","level":3,"selected":true,"parentId":null}}`},
		{name: "unknown field", raw: `{"schemaVersion":"1","kind":"map-position","longitude":1,"latitude":2,"extra":true}`, wantErr: true},
		{name: "wrong provider", raw: `{"schemaVersion":"1","kind":"map-feature","provider":"other","sourceKey":"x","featureKey":"y","longitude":0,"latitude":0}`, wantErr: true},
		{name: "out of range", raw: `{"schemaVersion":"1","kind":"screen-position","relativeX":1.1,"relativeY":0}`, wantErr: true},
		{name: "custom invalid provider", raw: `{"schemaVersion":"1","kind":"custom","provider":"Invalid Provider","targetKey":"model-42","fallbackRelativeX":0.25,"fallbackRelativeY":0.75}`, wantErr: true},
		{name: "custom empty key", raw: `{"schemaVersion":"1","kind":"custom","provider":"example","targetKey":"","fallbackRelativeX":0.25,"fallbackRelativeY":0.75}`, wantErr: true},
		{name: "custom out of range fallback", raw: `{"schemaVersion":"1","kind":"custom","provider":"example","targetKey":"model-42","fallbackRelativeX":-0.1,"fallbackRelativeY":0.75}`, wantErr: true},
		{name: "custom invalid metadata key", raw: `{"schemaVersion":"1","kind":"custom","provider":"example","targetKey":"model-42","fallbackRelativeX":0.25,"fallbackRelativeY":0.75,"metadata":{"_private":true}}`, wantErr: true},
		{name: "custom nested metadata", raw: `{"schemaVersion":"1","kind":"custom","provider":"example","targetKey":"model-42","fallbackRelativeX":0.25,"fallbackRelativeY":0.75,"metadata":{"nested":{"value":true}}}`, wantErr: true},
		{name: "custom array metadata", raw: `{"schemaVersion":"1","kind":"custom","provider":"example","targetKey":"model-42","fallbackRelativeX":0.25,"fallbackRelativeY":0.75,"metadata":{"items":[1]}}`, wantErr: true},
		{name: "custom unknown field", raw: `{"schemaVersion":"1","kind":"custom","provider":"example","targetKey":"model-42","fallbackRelativeX":0.25,"fallbackRelativeY":0.75,"extra":true}`, wantErr: true},
		{name: "trailing JSON", raw: `{"schemaVersion":"1","kind":"map-position","longitude":0,"latitude":0}{}`, wantErr: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := ValidateTarget(json.RawMessage(test.raw))
			if test.wantErr && !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("ErrInvalidInputを期待しました: %v", err)
			}
			if !test.wantErr && err != nil {
				t.Fatalf("targetが拒否されました: %v", err)
			}
		})
	}
}

func TestValidateCustomTargetMetadataLimits(t *testing.T) {
	t.Parallel()
	base := map[string]any{
		"schemaVersion":     "1",
		"kind":              "custom",
		"provider":          "com.example.canvas",
		"targetKey":         "shape-1",
		"fallbackRelativeX": 0.25,
		"fallbackRelativeY": 0.75,
	}
	for name, metadata := range map[string]map[string]any{
		"文字列上限超過": {"value": strings.Repeat("x", 501)},
		"項目数上限超過": func() map[string]any {
			value := make(map[string]any, 21)
			for index := 0; index < 21; index++ {
				value[string(rune('a'+index))] = index
			}
			return value
		}(),
	} {
		name, metadata := name, metadata
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			target := make(map[string]any, len(base)+1)
			for key, value := range base {
				target[key] = value
			}
			target["metadata"] = metadata
			raw, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ValidateTarget(raw); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("ErrInvalidInputを期待しました: %v", err)
			}
		})
	}
}

func TestSanitizeLocationAppliesManifestPersistence(t *testing.T) {
	t.Parallel()
	manifest := json.RawMessage(`{
  "routes":[{
    "pageKey":"parcel.detail",
    "template":"/parcels/{parcelId}",
    "aliases":["/old/{parcelId}"],
    "parameters":{"parcelId":{"persistence":"store"}},
    "queryParameters":{
      "tab":{"persistence":"store"},
      "token":{"persistence":"hash"},
      "secret":{"persistence":"discard"}
    }
  }]
}`)
	location := json.RawMessage(`{
  "schemaVersion":"1",
  "pageKey":"parcel.detail",
  "routeTemplate":"/old/{parcelId}",
  "pathParameters":{"parcelId":123},
  "queryParameters":{"tab":"map","token":"abc","secret":"discard-me","unknown":"ignored"}
}`)

	got, err := SanitizeLocation(location, manifest)
	if err != nil {
		t.Fatalf("location sanitizeに失敗しました: %v", err)
	}
	var decoded struct {
		Path  map[string]string `json:"pathParameters"`
		Query map[string]string `json:"queryParameters"`
	}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Path["parcelId"] != "123" || decoded.Query["tab"] != "map" {
		t.Fatalf("store policyが反映されていません: %#v", decoded)
	}
	if decoded.Query["token"] != "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("hash policyが反映されていません: %#v", decoded.Query)
	}
	if _, exists := decoded.Query["secret"]; exists {
		t.Fatal("discard policyの値が残っています")
	}
	if _, exists := decoded.Query["unknown"]; exists {
		t.Fatal("manifestにないquery値が残っています")
	}
}

func TestSanitizeLocationRequiresAllPathParameters(t *testing.T) {
	t.Parallel()
	manifest := json.RawMessage(`{"routes":[{"pageKey":"detail","template":"/x/{id}","parameters":{"id":{"persistence":"store"}}}]}`)
	location := json.RawMessage(`{"schemaVersion":"1","pageKey":"detail","routeTemplate":"/x/{id}","pathParameters":{}}`)
	_, err := SanitizeLocation(location, manifest)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("path parameter不一致を拒否しませんでした: %v", err)
	}
}

func TestBuildDeepLink(t *testing.T) {
	t.Parallel()
	manifest := json.RawMessage(`{"routes":[{"pageKey":"detail","template":"/x/{id}","parameters":{"id":{"persistence":"store"}},"queryParameters":{"tab":{"persistence":"store"}}}]}`)
	location := json.RawMessage(`{"schemaVersion":"1","pageKey":"detail","routeTemplate":"/x/{id}","pathParameters":{"id":"a b"},"queryParameters":{"tab":"map view"}}`)
	got, err := BuildDeepLink("https://example.test/root/", "feedbackThread", manifest, location, "thread-id")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://example.test/root/x/a%20b?tab=map%20view&feedbackThread=thread-id"
	if got != want {
		t.Fatalf("deep link mismatch\nwant: %s\n got: %s", want, got)
	}
}

func TestBuildDeepLinkFallsBackForHashedPath(t *testing.T) {
	t.Parallel()
	manifest := json.RawMessage(`{"routes":[{"pageKey":"detail","template":"/x/{id}","parameters":{"id":{"persistence":"hash"}}}]}`)
	location := json.RawMessage(`{"schemaVersion":"1","pageKey":"detail","routeTemplate":"/x/{id}","pathParameters":{"id":"sha256:abc"}}`)
	got, err := BuildDeepLink("https://example.test/root", "thread", manifest, location, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://example.test/root/?thread=t1" {
		t.Fatalf("fallback mismatch: %s", got)
	}
}

func TestCursorRoundTripAndRejectsInvalid(t *testing.T) {
	t.Parallel()
	for _, offset := range []int{0, 1, 200, 123456} {
		encoded := EncodeCursor(offset)
		decoded, err := DecodeCursor(&encoded)
		if err != nil || decoded != offset {
			t.Fatalf("cursor round-trip: offset=%d decoded=%d err=%v", offset, decoded, err)
		}
	}
	for _, value := range []string{"", "not-base64", "b2Zmc2V0Oi0x", "eDoz"} {
		if _, err := DecodeCursor(&value); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("不正cursorを拒否しませんでした: %q %v", value, err)
		}
	}
}
