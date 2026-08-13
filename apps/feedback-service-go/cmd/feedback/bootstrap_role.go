package main

import (
	"errors"
	"fmt"
)

type bootstrapInvocation struct {
	inputPath string
}

func parseBootstrapInvocation(arguments []string) (bootstrapInvocation, error) {
	if len(arguments) == 0 {
		return bootstrapInvocation{}, nil
	}
	if len(arguments) != 2 || arguments[0] != "--input" || arguments[1] == "" {
		return bootstrapInvocation{}, bootstrapUsage()
	}
	return bootstrapInvocation{inputPath: arguments[1]}, nil
}

func bootstrapUsage() error {
	return errors.New("usage: feedback bootstrap [--input <installation-manifest.json>]")
}

func invalidBootstrapInput(path string, err error) error {
	return fmt.Errorf("--input %q のinstallation manifestを読めません: %w", path, err)
}
