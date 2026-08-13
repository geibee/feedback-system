package main

import "testing"

func TestParseBootstrapInvocation(t *testing.T) {
	t.Parallel()

	legacy, err := parseBootstrapInvocation(nil)
	if err != nil || legacy.inputPath != "" {
		t.Fatalf("legacy invocation=%+v err=%v", legacy, err)
	}
	file, err := parseBootstrapInvocation([]string{"--input", "installation.json"})
	if err != nil || file.inputPath != "installation.json" {
		t.Fatalf("file invocation=%+v err=%v", file, err)
	}
	for _, arguments := range [][]string{
		{"--input"}, {"--input", ""}, {"--unknown", "installation.json"}, {"installation.json"},
	} {
		if _, err := parseBootstrapInvocation(arguments); err == nil {
			t.Fatalf("不正bootstrap invocationを受理しました: %v", arguments)
		}
	}
}
