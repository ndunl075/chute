package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ndunl075/chute/server/room"
	"github.com/ndunl075/chute/server/signal"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "", "optional directory to serve the web client")
	flag.Parse()

	hub := room.NewHub()
	mux := http.NewServeMux()

	mux.Handle("/ws", &signal.HubHandler{Hub: hub})
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	if *staticDir != "" {
		abs, err := filepath.Abs(*staticDir)
		if err != nil {
			log.Fatal(err)
		}
		fs := http.FileServer(http.Dir(abs))
		mux.Handle("/", spaHandler(abs, fs))
		log.Printf("serving static from %s", abs)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           withCORS(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("chute signaling listening on %s", *addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves index.html for unknown paths so /r/:id works.
func spaHandler(root string, fs http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(root, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}
