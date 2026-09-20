package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ndunl075/chute/server/config"
	"github.com/ndunl075/chute/server/fallback"
	"github.com/ndunl075/chute/server/room"
	"github.com/ndunl075/chute/server/signal"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "", "optional directory to serve the web client")
	flag.Parse()

	hub := room.NewHub()
	cfg := config.FromEnv()
	store := fallback.NewStore()

	mux := http.NewServeMux()
	mux.Handle("/ws", &signal.HubHandler{Hub: hub})
	mux.HandleFunc("GET /api/config", cfg.Handler())
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	store.Mount(mux)

	var handler http.Handler = mux
	if *staticDir != "" {
		abs, err := filepath.Abs(*staticDir)
		if err != nil {
			log.Fatal(err)
		}
		handler = withStatic(mux, abs)
		log.Printf("serving static from %s", abs)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           withCORS(handler),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("chute signaling listening on %s (fallback=%v, iceServers=%d)", *addr, cfg.Fallback, len(cfg.IceServers))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func withStatic(api http.Handler, root string) http.Handler {
	fs := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" ||
			r.URL.Path == "/health" ||
			r.URL.Path == "/api/config" ||
			strings.HasPrefix(r.URL.Path, "/api/fallback/") {
			api.ServeHTTP(w, r)
			return
		}
		path := filepath.Join(root, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
