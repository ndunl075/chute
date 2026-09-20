package fallback

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPutGetChunk(t *testing.T) {
	s := NewStore()
	mux := http.NewServeMux()
	s.Mount(mux)

	body := []byte("cipher-text")
	req := httptest.NewRequest(http.MethodPut, "/api/fallback/room1/tx1/chunk/0", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("put status %d", rr.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/fallback/room1/tx1/chunk/0", nil)
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get status %d", rr.Code)
	}
	if !bytes.Equal(rr.Body.Bytes(), body) {
		t.Fatalf("body mismatch")
	}
}
