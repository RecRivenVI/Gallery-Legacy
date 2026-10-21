package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func schemaRows(t *testing.T, db *sql.DB, query string) []map[string]any {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		row := map[string]any{}
		for i, name := range names {
			row[name] = values[i]
		}
		result = append(result, row)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCreateLiveNodeDifferential(t *testing.T) {
	file := os.Getenv("GALLERY_SCHEMA_GOLDEN")
	if file == "" {
		t.Skip("run schema differential to create Node reference")
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		InstanceRoot string
		Sources      map[string]string
		Expected     map[string]any
		Tables       []string
		Checks       []struct {
			Name, File string
			Options    ContractOptions
			Code       *string
		}
	}
	if err = json.Unmarshal(bytes, &golden); err != nil {
		t.Fatal(err)
	}
	for _, check := range golden.Checks {
		t.Run(check.Name, func(t *testing.T) {
			read, err := sql.Open("sqlite", check.File+"?_pragma=foreign_keys(1)")
			if err != nil {
				t.Fatal(err)
			}
			defer read.Close()
			err = VerifyContract(context.Background(), read, check.Options)
			if check.Code == nil {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || strings.Split(err.Error(), ":")[0] != *check.Code {
				t.Fatalf("Node=%s Go=%v", *check.Code, err)
			}
		})
	}
	if err = CreateLive(context.Background(), golden.InstanceRoot, golden.Sources); err != nil {
		t.Fatal(err)
	}
	database := filepath.Join(golden.InstanceRoot, "live", "catalog.sqlite")
	db, err := sql.Open("sqlite", database+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	actual := map[string]any{}
	objects := schemaRows(t, db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
	for _, row := range objects {
		if sql, ok := row["sql"].(string); ok {
			row["sql"] = strings.Join(strings.Fields(sql), " ")
		}
	}
	actual["objects"] = objects
	for _, table := range golden.Tables {
		rows := schemaRows(t, db, "SELECT * FROM "+table)
		if table == "catalog_state" {
			for _, row := range rows {
				delete(row, "built_at_ms")
			}
		}
		if table == "live_meta" {
			for _, row := range rows {
				delete(row, "epoch")
				delete(row, "initialized_at_ms")
			}
		}
		actual[table] = rows
	}
	encoded, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var comparable map[string]any
	if err = json.Unmarshal(encoded, &comparable); err != nil {
		t.Fatal(err)
	}
	for key, expected := range golden.Expected {
		if !reflect.DeepEqual(comparable[key], expected) {
			t.Errorf("schema field %s differs from Node", key)
		}
	}
	if len(comparable) != len(golden.Expected) {
		t.Fatal("projection key count differs")
	}
	if _, err = Validate(context.Background(), db, true); err != nil {
		t.Fatal(err)
	}
	writer, err := Open(database)
	if err != nil {
		t.Fatal(err)
	}
	if err = writer.AssertBindings(context.Background(), golden.Sources); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(database)
	if err != nil {
		t.Fatal(err)
	}
	if err = CreateLive(context.Background(), golden.InstanceRoot, golden.Sources); err == nil || !strings.Contains(err.Error(), "LIVE_OUTPUT_EXISTS") {
		t.Fatalf("existing database accepted: %v", err)
	}
	after, err := os.ReadFile(database)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("existing catalog modified")
	}
}

func TestPublishNewCatalogDoesNotReplaceDestination(t *testing.T) {
	root := t.TempDir()
	source, target := filepath.Join(root, "new"), filepath.Join(root, "existing")
	if err := os.WriteFile(source, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installNewFile(source, target); err == nil {
		t.Fatal("overwrote existing target")
	}
	bytes, err := os.ReadFile(target)
	if err != nil || string(bytes) != "existing" {
		t.Fatalf("existing target changed: %q %v", bytes, err)
	}
}
