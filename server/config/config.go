package config

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
)

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type PublicConfig struct {
	IceServers []IceServer `json:"iceServers"`
	Fallback   bool        `json:"fallback"`
}

func FromEnv() PublicConfig {
	cfg := PublicConfig{
		IceServers: []IceServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		},
		Fallback: true,
	}

	if stun := os.Getenv("CHUTE_STUN_URLS"); stun != "" {
		cfg.IceServers = nil
		for _, u := range strings.Split(stun, ",") {
			u = strings.TrimSpace(u)
			if u != "" {
				cfg.IceServers = append(cfg.IceServers, IceServer{URLs: []string{u}})
			}
		}
	}

	turnURL := firstEnv("CHUTE_TURN_URL", "TURN_URL")
	if turnURL != "" {
		user := firstEnv("CHUTE_TURN_USERNAME", "TURN_USERNAME")
		pass := firstEnv("CHUTE_TURN_CREDENTIAL", "TURN_CREDENTIAL")
		if user == "" {
			user = "chute"
		}
		if pass == "" {
			pass = "chute"
		}
		urls := make([]string, 0)
		for _, u := range strings.Split(turnURL, ",") {
			u = strings.TrimSpace(u)
			if u != "" {
				urls = append(urls, u)
			}
		}
		cfg.IceServers = append(cfg.IceServers, IceServer{
			URLs:       urls,
			Username:   user,
			Credential: pass,
		})
	}

	return cfg
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

func (c PublicConfig) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(c)
	}
}
