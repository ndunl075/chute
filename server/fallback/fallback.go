package fallback

import (
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxChunkBytes = 256 << 10 // 256 KiB ciphertext cap
	maxChunks     = 200_000
	ttl           = 2 * time.Hour
)

type chunkStore struct {
	mu      sync.Mutex
	rooms   map[string]*transfer
	expires time.Time
}

type transfer struct {
	mu      sync.Mutex
	meta    []byte
	chunks  map[int][]byte
	done    bool
	updated time.Time
}

// Store is an in-memory encrypted chunk buffer. Server never sees plaintext.
type Store struct {
	mu      sync.Mutex
	items   map[string]*chunkStore
	Allow   func(ip string, n int) bool
	OnComplete func()
}

func NewStore() *Store {
	s := &Store{items: make(map[string]*chunkStore)}
	go s.reap()
	return s
}

func (s *Store) reap() {
	t := time.NewTicker(10 * time.Minute)
	for range t.C {
		s.mu.Lock()
		now := time.Now()
		for k, v := range s.items {
			v.mu.Lock()
			if now.After(v.expires) {
				delete(s.items, k)
			}
			v.mu.Unlock()
		}
		s.mu.Unlock()
	}
}

func (s *Store) room(id string) *chunkStore {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.items[id]
	if !ok {
		r = &chunkStore{
			rooms:   make(map[string]*transfer),
			expires: time.Now().Add(ttl),
		}
		s.items[id] = r
	}
	r.expires = time.Now().Add(ttl)
	return r
}

func (s *Store) Mount(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/fallback/{room}/{transfer}/meta", s.putMeta)
	mux.HandleFunc("GET /api/fallback/{room}/{transfer}/meta", s.getMeta)
	mux.HandleFunc("PUT /api/fallback/{room}/{transfer}/chunk/{index}", s.putChunk)
	mux.HandleFunc("GET /api/fallback/{room}/{transfer}/chunk/{index}", s.getChunk)
	mux.HandleFunc("POST /api/fallback/{room}/{transfer}/complete", s.complete)
	mux.HandleFunc("GET /api/fallback/{room}/{transfer}/status", s.status)
}

func (s *Store) Handler() http.Handler {
	mux := http.NewServeMux()
	s.Mount(mux)
	return mux
}

func (s *Store) putMeta(w http.ResponseWriter, r *http.Request) {
	body, err := readLimited(r.Body, 64<<10)
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	if s.Allow != nil && !s.Allow(clientIP(r), len(body)) {
		http.Error(w, "fallback quota exceeded", http.StatusTooManyRequests)
		return
	}
	tr := s.getTransfer(r.PathValue("room"), r.PathValue("transfer"), true)
	tr.mu.Lock()
	tr.meta = body
	tr.updated = time.Now()
	tr.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Store) getMeta(w http.ResponseWriter, r *http.Request) {
	tr := s.getTransfer(r.PathValue("room"), r.PathValue("transfer"), false)
	if tr == nil {
		http.NotFound(w, r)
		return
	}
	tr.mu.Lock()
	meta := tr.meta
	tr.mu.Unlock()
	if meta == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(meta)
}

func (s *Store) putChunk(w http.ResponseWriter, r *http.Request) {
	idx, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || idx < 0 || idx >= maxChunks {
		http.Error(w, "bad index", http.StatusBadRequest)
		return
	}
	body, err := readLimited(r.Body, maxChunkBytes)
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	if s.Allow != nil && !s.Allow(clientIP(r), len(body)) {
		http.Error(w, "fallback quota exceeded", http.StatusTooManyRequests)
		return
	}
	tr := s.getTransfer(r.PathValue("room"), r.PathValue("transfer"), true)
	tr.mu.Lock()
	if len(tr.chunks) >= maxChunks {
		tr.mu.Unlock()
		http.Error(w, "too many chunks", http.StatusInsufficientStorage)
		return
	}
	tr.chunks[idx] = body
	tr.updated = time.Now()
	tr.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Store) getChunk(w http.ResponseWriter, r *http.Request) {
	idx, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		http.Error(w, "bad index", http.StatusBadRequest)
		return
	}
	tr := s.getTransfer(r.PathValue("room"), r.PathValue("transfer"), false)
	if tr == nil {
		http.NotFound(w, r)
		return
	}
	tr.mu.Lock()
	chunk, ok := tr.chunks[idx]
	tr.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(chunk)
}

func (s *Store) complete(w http.ResponseWriter, r *http.Request) {
	tr := s.getTransfer(r.PathValue("room"), r.PathValue("transfer"), true)
	tr.mu.Lock()
	tr.done = true
	tr.updated = time.Now()
	tr.mu.Unlock()
	if s.OnComplete != nil {
		s.OnComplete()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Store) status(w http.ResponseWriter, r *http.Request) {
	tr := s.getTransfer(r.PathValue("room"), r.PathValue("transfer"), false)
	if tr == nil {
		http.NotFound(w, r)
		return
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(
		`{"chunks":` + strconv.Itoa(len(tr.chunks)) +
			`,"done":` + strconv.FormatBool(tr.done) + `}`,
	))
}

func (s *Store) getTransfer(roomID, transferID string, create bool) *transfer {
	r := s.room(roomID)
	r.mu.Lock()
	defer r.mu.Unlock()
	tr, ok := r.rooms[transferID]
	if !ok {
		if !create {
			return nil
		}
		tr = &transfer{chunks: make(map[int][]byte), updated: time.Now()}
		r.rooms[transferID] = tr
	}
	return tr
}

func readLimited(r io.Reader, n int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, n+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > n {
		return nil, io.ErrUnexpectedEOF
	}
	return data, nil
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
