package main

import "testing"

func TestParseManifestInvocation(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"FEEDBACK_MANIFEST_ACCESS_TOKEN_FILE": "/run/secrets/feedback-token",
		"FEEDBACK_MANIFEST_SCOPE":             "feedback.admin",
	}
	settings, err := parseManifestInvocation(
		[]string{"apply", "--input", "manifest.json", "--api-base-url", "https://feedback.example.test/feedback/v1"},
		func(name string) (string, bool) { value, ok := values[name]; return value, ok },
	)
	if err != nil {
		t.Fatal(err)
	}
	if settings.ManifestFile != "manifest.json" || settings.APIBaseURL != "https://feedback.example.test/feedback/v1" ||
		settings.AccessTokenFile != "/run/secrets/feedback-token" {
		t.Fatalf("manifest settings = %+v", settings)
	}
	for _, arguments := range [][]string{{}, {"plan"}, {"apply", "extra"}, {"apply", "--unknown"}} {
		if _, err := parseManifestInvocation(arguments, func(string) (string, bool) { return "", false }); err == nil {
			t.Fatalf("不正manifest invocationを受理しました: %v", arguments)
		}
	}
}
