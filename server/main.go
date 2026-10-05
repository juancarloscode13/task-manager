package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

const (
	dataFileName  = "data.json"
	maxDataBytes  = 16 << 20
	defaultData   = "{\n  \"version\": 2,\n  \"boards\": []\n}\n"
	maxIdentifier = 120
)

var requiredColumnIDs = []string{"todo", "in-progress", "testing", "done"}
var validPriorities = map[string]bool{"low": true, "medium": true, "high": true, "urgent": true}

type FileData struct {
	Version int     `json:"version"`
	Boards  []Board `json:"boards"`
}

type Board struct {
	ID       string   `json:"id"`
	Settings Settings `json:"settings"`
	Columns  []Column `json:"columns"`
	Tasks    []Task   `json:"tasks"`
}

type Settings struct {
	BoardTitle string `json:"boardTitle"`
}

type Column struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Task struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
	ColumnID    string `json:"columnId"`
	Order       int    `json:"order"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type dataStore struct {
	path string
	mu   sync.Mutex
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		log.Fatal("cannot determine Taskboard directory: ", err)
	}
	publicDir := filepath.Join(root, "public")
	if info, err := os.Stat(publicDir); err != nil || !info.IsDir() {
		log.Fatalf("public directory not found at %s", publicDir)
	}
	if err := ensureDataFile(root); err != nil {
		log.Fatal("cannot initialize data.json: ", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:3000")
	if err != nil {
		log.Fatal("cannot listen on 127.0.0.1:3000: ", err)
	}
	server := &http.Server{
		Handler:           newHandler(&dataStore{path: filepath.Join(root, dataFileName)}, publicDir),
		ReadHeaderTimeout: 5 * time.Second,
	}
	fmt.Println("Taskboard server running on http://localhost:3000")
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("HTTP server stopped: ", err)
	}
}

func ensureDataFile(directory string) error {
	path := filepath.Join(directory, dataFileName)
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return writeAtomicFile(path, []byte(defaultData))
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	if len(bytes.TrimSpace(contents)) > 0 {
		if _, validationErr := validateFileData(contents); validationErr == nil {
			return nil
		}
	}

	if err := backupInvalidFile(path, contents); err != nil {
		return fmt.Errorf("back up invalid %s: %w", path, err)
	}
	return writeAtomicFile(path, []byte(defaultData))
}

func backupInvalidFile(path string, contents []byte) error {
	backupPath := path + ".bak"
	if _, err := os.Stat(backupPath); err == nil {
		backupPath = path + ".bak." + time.Now().UTC().Format("20060102T150405.000000000")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeAtomicFile(backupPath, contents)
}

func writeAtomicFile(path string, contents []byte) (resultErr error) {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = os.Remove(temporaryPath)
	}()

	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if dir, err := os.Open(directory); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func validateFileData(contents []byte) (FileData, error) {
	root, err := decodeObject(contents, "el archivo")
	if err != nil {
		return FileData{}, err
	}
	if err := requireFields(root, "version", "boards"); err != nil {
		return FileData{}, err
	}
	var file FileData
	if err := json.Unmarshal(contents, &file); err != nil {
		return FileData{}, fmt.Errorf("JSON no válido: %w", err)
	}
	if file.Version != 2 {
		return FileData{}, errors.New("la versión del archivo debe ser 2")
	}
	if file.Boards == nil {
		return FileData{}, errors.New("boards debe ser un array")
	}

	var boardRows []json.RawMessage
	if err := json.Unmarshal(root["boards"], &boardRows); err != nil || boardRows == nil {
		return FileData{}, errors.New("boards debe ser un array")
	}
	if len(boardRows) != len(file.Boards) {
		return FileData{}, errors.New("boards contiene un elemento no válido")
	}

	boardIDs := make(map[string]bool, len(file.Boards))
	for index := range file.Boards {
		board := &file.Boards[index]
		fields, err := decodeObject(boardRows[index], "un tablero")
		if err != nil {
			return FileData{}, err
		}
		if err := requireFields(fields, "id", "settings", "columns", "tasks"); err != nil {
			return FileData{}, fmt.Errorf("tablero %d: %w", index+1, err)
		}
		board.ID, err = requiredString(fields, "id")
		if err != nil || strings.TrimSpace(board.ID) == "" || textLength(strings.TrimSpace(board.ID)) > maxIdentifier {
			return FileData{}, fmt.Errorf("tablero %d necesita un id válido de hasta %d caracteres", index+1, maxIdentifier)
		}
		board.ID = strings.TrimSpace(board.ID)
		if boardIDs[board.ID] {
			return FileData{}, errors.New("los id de los tableros deben ser únicos")
		}
		boardIDs[board.ID] = true

		settingsFields, err := decodeObject(fields["settings"], "la configuración de un tablero")
		if err != nil {
			return FileData{}, err
		}
		if err := requireFields(settingsFields, "boardTitle"); err != nil {
			return FileData{}, fmt.Errorf("tablero %q: %w", board.ID, err)
		}
		board.Settings.BoardTitle, err = requiredString(settingsFields, "boardTitle")
		board.Settings.BoardTitle = strings.TrimSpace(board.Settings.BoardTitle)
		if err != nil || board.Settings.BoardTitle == "" || textLength(board.Settings.BoardTitle) > 80 {
			return FileData{}, fmt.Errorf("el nombre del tablero %q debe tener entre 1 y 80 caracteres", board.ID)
		}

		var columnRows []json.RawMessage
		if err := json.Unmarshal(fields["columns"], &columnRows); err != nil || columnRows == nil || len(columnRows) != len(requiredColumnIDs) {
			return FileData{}, fmt.Errorf("el tablero %q debe contener las cuatro columnas", board.ID)
		}
		var boardColumns []Column
		if err := json.Unmarshal(fields["columns"], &boardColumns); err != nil {
			return FileData{}, fmt.Errorf("el tablero %q contiene una columna no válida", board.ID)
		}
		columnIDs := make(map[string]bool, len(boardColumns))
		for columnIndex := range boardColumns {
			columnFields, err := decodeObject(columnRows[columnIndex], "una columna")
			if err != nil {
				return FileData{}, err
			}
			if err := requireFields(columnFields, "id", "name"); err != nil {
				return FileData{}, fmt.Errorf("columna %d del tablero %q: %w", columnIndex+1, board.ID, err)
			}
			columnID, idErr := requiredString(columnFields, "id")
			columnName, nameErr := requiredString(columnFields, "name")
			columnName = strings.TrimSpace(columnName)
			if idErr != nil || nameErr != nil || columnID != requiredColumnIDs[columnIndex] || columnIDs[columnID] || columnName == "" || textLength(columnName) > 40 {
				return FileData{}, fmt.Errorf("las columnas del tablero %q deben mantener sus identificadores y nombres válidos", board.ID)
			}
			columnIDs[columnID] = true
			boardColumns[columnIndex] = Column{ID: columnID, Name: columnName}
		}
		board.Columns = boardColumns

		var taskRows []json.RawMessage
		if err := json.Unmarshal(fields["tasks"], &taskRows); err != nil || taskRows == nil {
			return FileData{}, fmt.Errorf("la lista de tareas del tablero %q debe ser un array", board.ID)
		}
		var boardTasks []Task
		if err := json.Unmarshal(fields["tasks"], &boardTasks); err != nil {
			return FileData{}, fmt.Errorf("el tablero %q contiene una tarea no válida", board.ID)
		}
		taskIDs := make(map[string]bool, len(boardTasks))
		orders := make(map[string]bool, len(boardTasks))
		for taskIndex := range boardTasks {
			task := &boardTasks[taskIndex]
			taskFields, err := decodeObject(taskRows[taskIndex], "una tarea")
			if err != nil {
				return FileData{}, err
			}
			if err := requireFields(taskFields, "id", "title", "description", "priority", "columnId", "order", "createdAt", "updatedAt"); err != nil {
				return FileData{}, fmt.Errorf("tarea %d del tablero %q: %w", taskIndex+1, board.ID, err)
			}
			for _, field := range []string{"id", "title", "description", "priority", "columnId", "createdAt", "updatedAt"} {
				if _, err := requiredString(taskFields, field); err != nil {
					return FileData{}, fmt.Errorf("tarea %d del tablero %q: %w", taskIndex+1, board.ID, err)
				}
			}
			task.Order, err = requiredInteger(taskFields, "order")
			if err != nil {
				return FileData{}, fmt.Errorf("tarea %d del tablero %q: %w", taskIndex+1, board.ID, err)
			}
			task.ID = strings.TrimSpace(task.ID)
			task.Title = strings.TrimSpace(task.Title)
			task.CreatedAt = strings.TrimSpace(task.CreatedAt)
			task.UpdatedAt = strings.TrimSpace(task.UpdatedAt)
			if task.ID == "" || textLength(task.ID) > maxIdentifier || taskIDs[task.ID] {
				return FileData{}, fmt.Errorf("los id de las tareas del tablero %q deben ser válidos y únicos", board.ID)
			}
			if task.Title == "" || textLength(task.Title) > 120 {
				return FileData{}, fmt.Errorf("cada tarea del tablero %q necesita un título de hasta 120 caracteres", board.ID)
			}
			if textLength(task.Description) > 1000 {
				return FileData{}, fmt.Errorf("una descripción del tablero %q supera los 1000 caracteres", board.ID)
			}
			if !validPriorities[task.Priority] {
				return FileData{}, fmt.Errorf("una tarea del tablero %q tiene una prioridad desconocida", board.ID)
			}
			if !columnIDs[task.ColumnID] {
				return FileData{}, fmt.Errorf("una tarea del tablero %q apunta a una columna inexistente", board.ID)
			}
			if task.Order < 0 {
				return FileData{}, fmt.Errorf("una tarea del tablero %q tiene un orden no válido", board.ID)
			}
			orderKey := fmt.Sprintf("%s:%d", task.ColumnID, task.Order)
			if orders[orderKey] {
				return FileData{}, fmt.Errorf("hay dos tareas en la misma posición de una columna del tablero %q", board.ID)
			}
			if _, err := time.Parse(time.RFC3339Nano, task.CreatedAt); err != nil {
				return FileData{}, fmt.Errorf("una fecha de creación del tablero %q no es válida", board.ID)
			}
			if _, err := time.Parse(time.RFC3339Nano, task.UpdatedAt); err != nil {
				return FileData{}, fmt.Errorf("una fecha de modificación del tablero %q no es válida", board.ID)
			}
			taskIDs[task.ID] = true
			orders[orderKey] = true
		}
		board.Tasks = boardTasks
	}
	return file, nil
}

func decodeObject(raw json.RawMessage, description string) (map[string]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("%s debe ser un objeto JSON", description)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("%s no es un objeto JSON válido", description)
	}
	return fields, nil
}

func requireFields(fields map[string]json.RawMessage, names ...string) error {
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return fmt.Errorf("falta el campo obligatorio %q", name)
		}
	}
	return nil
}

func requiredString(fields map[string]json.RawMessage, name string) (string, error) {
	if trimmed := bytes.TrimSpace(fields[name]); len(trimmed) == 0 || trimmed[0] != '"' {
		return "", fmt.Errorf("el campo %q debe ser una cadena", name)
	}
	var value string
	if err := json.Unmarshal(fields[name], &value); err != nil {
		return "", fmt.Errorf("el campo %q debe ser una cadena", name)
	}
	return value, nil
}

func requiredInteger(fields map[string]json.RawMessage, name string) (int, error) {
	trimmed := bytes.TrimSpace(fields[name])
	if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
		return 0, fmt.Errorf("el campo %q debe ser un entero", name)
	}
	var value int
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, fmt.Errorf("el campo %q debe ser un entero", name)
	}
	return value, nil
}

func textLength(value string) int {
	length := 0
	for _, character := range value {
		length += utf16.RuneLen(character)
	}
	return length
}

func (store *dataStore) load() (FileData, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	if err := ensureDataFile(filepath.Dir(store.path)); err != nil {
		return FileData{}, err
	}
	contents, err := os.ReadFile(store.path)
	if err != nil {
		return FileData{}, err
	}
	return validateFileData(contents)
}

func (store *dataStore) save(contents []byte) error {
	file, err := validateFileData(contents)
	if err != nil {
		return err
	}
	canonical, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	canonical = append(canonical, '\n')

	store.mu.Lock()
	defer store.mu.Unlock()
	return writeAtomicFile(store.path, canonical)
}

func newHandler(store *dataStore, publicDir string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/data", dataHandler{store: store})
	mux.HandleFunc("/api/", func(writer http.ResponseWriter, request *http.Request) {
		http.NotFound(writer, request)
	})
	mux.Handle("/", http.FileServer(http.Dir(publicDir)))
	return mux
}

type dataHandler struct {
	store *dataStore
}

func (handler dataHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		file, err := handler.store.load()
		if err != nil {
			writeAPIError(writer, http.StatusInternalServerError, "no se pudo leer data.json")
			return
		}
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(writer).Encode(file); err != nil {
			return
		}
	case http.MethodPut:
		if origin := request.Header.Get("Origin"); origin != "" && origin != "http://localhost:3000" && origin != "http://127.0.0.1:3000" {
			writeAPIError(writer, http.StatusForbidden, "origen no permitido")
			return
		}
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeAPIError(writer, http.StatusUnsupportedMediaType, "Content-Type debe ser application/json")
			return
		}
		request.Body = http.MaxBytesReader(writer, request.Body, maxDataBytes)
		contents, err := io.ReadAll(request.Body)
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				writeAPIError(writer, http.StatusRequestEntityTooLarge, "el archivo supera el tamaño máximo permitido")
			} else {
				writeAPIError(writer, http.StatusBadRequest, "no se pudo leer el cuerpo de la petición")
			}
			return
		}
		if _, err := validateFileData(contents); err != nil {
			writeAPIError(writer, http.StatusBadRequest, err.Error())
			return
		}
		if err := handler.store.save(contents); err != nil {
			writeAPIError(writer, http.StatusInternalServerError, "no se pudo guardar data.json")
			return
		}
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, "{\"ok\":true}\n")
	default:
		writer.Header().Set("Allow", "GET, PUT")
		writeAPIError(writer, http.StatusMethodNotAllowed, "método no permitido")
	}
}

func writeAPIError(writer http.ResponseWriter, status int, message string) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": message})
}
