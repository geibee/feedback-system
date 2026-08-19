package migrations

import "testing"

func TestLoadIncludesGoOwnedMigrations(t *testing.T) {
	t.Parallel()
	definitions, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions) != 3 || definitions[0].Version != 7 ||
		definitions[0].Description != "review scope perspectives" ||
		definitions[1].Version != 8 || definitions[1].Description != "derive application memberships" ||
		definitions[2].Version != 9 || definitions[2].Description != "triage reactions and unread" {
		t.Fatalf("definitions = %+v", definitions)
	}
}
