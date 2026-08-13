package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/manifestapply"
)

func runManifest(arguments []string) error {
	settings, err := parseManifestInvocation(arguments, os.LookupEnv)
	if err != nil {
		return err
	}
	client, err := manifestapply.NewClient(&http.Client{})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result, err := client.Apply(ctx, settings)
	if err != nil {
		return fmt.Errorf("application manifestを同期できません: %w", err)
	}
	status := "unchanged"
	if result.Changed {
		status = "applied"
	}
	fmt.Printf(
		"Feedback manifest %s: application=%s manifestVersion=%s etag=%s\n",
		status, result.ApplicationKey, result.ManifestVersion, result.ETag,
	)
	return nil
}

func parseManifestInvocation(arguments []string, lookup func(string) (string, bool)) (manifestapply.Settings, error) {
	if len(arguments) == 0 || arguments[0] != "apply" {
		return manifestapply.Settings{}, errors.New("usage: feedback manifest apply --input <manifest.json> --api-base-url <url>")
	}
	flags := flag.NewFlagSet("feedback manifest apply", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	manifestFile := flags.String("input", environmentLookup(lookup, "FEEDBACK_MANIFEST_INPUT"), "application manifest JSON file")
	apiBaseURL := flags.String("api-base-url", environmentLookup(lookup, "FEEDBACK_MANIFEST_API_BASE_URL"), "Feedback API base URL")
	if err := flags.Parse(arguments[1:]); err != nil {
		return manifestapply.Settings{}, err
	}
	if flags.NArg() != 0 {
		return manifestapply.Settings{}, errors.New("feedback manifest applyに位置引数は指定できません")
	}
	return manifestapply.Settings{
		APIBaseURL:      *apiBaseURL,
		ManifestFile:    *manifestFile,
		AccessToken:     environmentLookup(lookup, "FEEDBACK_MANIFEST_ACCESS_TOKEN"),
		AccessTokenFile: environmentLookup(lookup, "FEEDBACK_MANIFEST_ACCESS_TOKEN_FILE"),
		TokenURL:        environmentLookup(lookup, "FEEDBACK_MANIFEST_TOKEN_URL"),
		ClientID:        environmentLookup(lookup, "FEEDBACK_MANIFEST_CLIENT_ID"),
		ClientSecret:    environmentLookup(lookup, "FEEDBACK_MANIFEST_CLIENT_SECRET"),
		Scope:           environmentLookup(lookup, "FEEDBACK_MANIFEST_SCOPE"),
		AllowHTTP:       environmentLookup(lookup, "FEEDBACK_ALLOW_INSECURE_HTTP") == "1",
	}, nil
}

func environmentLookup(lookup func(string) (string, bool), name string) string {
	if lookup == nil {
		return ""
	}
	value, _ := lookup(name)
	return strings.TrimSpace(value)
}
