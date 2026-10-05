package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureDataFileCreatesDefaultWhenMissing(t *testing.T) {
	directory := t.TempDir()
	if err := ensureDataFile(directory); err != nil {
		t.Fatalf("ensureDataFile() error = %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(directory, dataFileName))
	if err != nil {
		t.Fatalf("read created data file: %v", err)
	}
	if string(contents) != defaultData {
		t.Fatalf("created data = %q, want %q", contents, defaultData)
	}
}

func TestEnsureDataFileRepairsInvalidFilesAndBacksThemUp(t *testing.T) {
	cases := []struct {
		name    string
		initial string
	}{
		{name: "empty", initial: ""},
		{name: "malformed JSON", initial: `{"version":2,"boards":`},
		{name: "invalid structure", initial: `{"version":999,"foo":"bar"}`},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, dataFileName)
			if err := os.WriteFile(path, []byte(testCase.initial), 0o600); err != nil {
				t.Fatalf("write corrupt input: %v", err)
			}
			if err := ensureDataFile(directory); err != nil {
				t.Fatalf("ensureDataFile() error = %v", err)
			}
			backup, err := os.ReadFile(path + ".bak")
			if err != nil {
				t.Fatalf("read corrupt backup: %v", err)
			}
			if string(backup) != testCase.initial {
				t.Fatalf("backup = %q, want original %q", backup, testCase.initial)
			}
			current, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read repaired data: %v", err)
			}
			if string(current) != defaultData {
				t.Fatalf("repaired data = %q, want %q", current, defaultData)
			}
		})
	}
}

func TestEnsureDataFilePreservesValidData(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, dataFileName)
	initial := []byte("{\n  \"version\": 2,\n  \"boards\": []\n}\n")
	if err := os.WriteFile(path, initial, 0o600); err != nil {
		t.Fatalf("write valid input: %v", err)
	}
	if err := ensureDataFile(directory); err != nil {
		t.Fatalf("ensureDataFile() error = %v", err)
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read data file: %v", err)
	}
	if string(current) != string(initial) {
		t.Fatalf("valid data changed: got %q, want %q", current, initial)
	}
}

func TestValidateFileDataValidatesBoardAndTaskStructure(t *testing.T) {
	good := `{"version":2,"boards":[{"id":"board-1","settings":{"boardTitle":"Estudios"},"columns":[{"id":"todo","name":"Por hacer"},{"id":"in-progress","name":"En proceso"},{"id":"testing","name":"Testing"},{"id":"done","name":"Completado"}],"tasks":[{"id":"task-1","title":"Estudiar","description":"","priority":"high","columnId":"todo","order":0,"createdAt":"2026-10-03T21:52:03.636Z","updatedAt":"2026-10-03T21:52:03.636Z"}]}]}`
	if _, err := validateFileData([]byte(good)); err != nil {
		t.Fatalf("valid board and task rejected: %v", err)
	}
	bad := `{"version":2,"boards":[{"id":"board-1","settings":{"boardTitle":"Estudios"},"columns":[],"tasks":[]}]}`
	if _, err := validateFileData([]byte(bad)); err == nil {
		t.Fatal("invalid board structure accepted")
	}
}

func TestDataAPIValidatesWritesAndKeepsDataPrivate(t *testing.T) {
	directory := t.TempDir()
	publicDir := filepath.Join(directory, "public")
	if err := os.Mkdir(publicDir, 0o700); err != nil {
		t.Fatalf("create public directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(publicDir, "index.html"), []byte("taskboard"), 0o600); err != nil {
		t.Fatalf("write public index: %v", err)
	}
	dataPath := filepath.Join(directory, dataFileName)
	initial := []byte(defaultData)
	if err := os.WriteFile(dataPath, initial, 0o600); err != nil {
		t.Fatalf("write data file: %v", err)
	}
	handler := newHandler(&dataStore{path: dataPath}, publicDir)

	root := httptest.NewRecorder()
	handler.ServeHTTP(root, httptest.NewRequest(http.MethodGet, "/", nil))
	if root.Code != http.StatusOK || root.Body.String() != "taskboard" {
		t.Fatalf("GET / = %d %q, want 200 and the public index", root.Code, root.Body.String())
	}

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/data", nil))
	if get.Code != http.StatusOK || get.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("GET /api/data = %d (%q)", get.Code, get.Header().Get("Content-Type"))
	}
	var got FileData
	if err := json.Unmarshal(get.Body.Bytes(), &got); err != nil || got.Version != 2 || got.Boards == nil {
		t.Fatalf("GET returned invalid data: %v", err)
	}

	invalidPut := httptest.NewRecorder()
	invalidRequest := httptest.NewRequest(http.MethodPut, "/api/data", strings.NewReader(`{"version":3,"boards":[]}`))
	invalidRequest.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(invalidPut, invalidRequest)
	if invalidPut.Code != http.StatusBadRequest {
		t.Fatalf("invalid PUT status = %d, want 400", invalidPut.Code)
	}
	current, err := os.ReadFile(dataPath)
	if err != nil {
		t.Fatalf("read unchanged data: %v", err)
	}
	if string(current) != string(initial) {
		t.Fatalf("invalid PUT changed data: got %q", current)
	}

	validPut := httptest.NewRecorder()
	validBody := `{"version":2,"boards":[{"id":"board-1","settings":{"boardTitle":"Estudios"},"columns":[{"id":"todo","name":"Por hacer"},{"id":"in-progress","name":"En proceso"},{"id":"testing","name":"Testing"},{"id":"done","name":"Completado"}],"tasks":[]}]}`
	validRequest := httptest.NewRequest(http.MethodPut, "/api/data", strings.NewReader(validBody))
	validRequest.Header.Set("Content-Type", "application/json")
	validRequest.Header.Set("Origin", "http://localhost:3000")
	handler.ServeHTTP(validPut, validRequest)
	if validPut.Code != http.StatusOK {
		t.Fatalf("valid PUT status = %d, want 200: %s", validPut.Code, validPut.Body.String())
	}
	current, err = os.ReadFile(dataPath)
	if err != nil {
		t.Fatalf("read saved data: %v", err)
	}
	saved, err := validateFileData(current)
	if err != nil || len(saved.Boards) != 1 || saved.Boards[0].Settings.BoardTitle != "Estudios" {
		t.Fatalf("valid PUT was not persisted: err=%v data=%+v", err, saved)
	}

	privateRequest := httptest.NewRecorder()
	handler.ServeHTTP(privateRequest, httptest.NewRequest(http.MethodGet, "/data.json", nil))
	if privateRequest.Code != http.StatusNotFound {
		t.Fatalf("GET /data.json status = %d, want 404", privateRequest.Code)
	}
}
