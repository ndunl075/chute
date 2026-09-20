package metrics

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Collector tracks lightweight operational metrics for the free tier.
type Collector struct {
	RoomsCreated   atomic.Uint64
	PeersJoined    atomic.Uint64
	FallbackBytes  atomic.Uint64
	FallbackReject atomic.Uint64
	TransfersDone  atomic.Uint64

	mu       sync.Mutex
	byDayIP  map[string]uint64 // key: day|ip
	dayQuota uint64
}

func New() *Collector {
	q := uint64(1 << 30) // 1 GiB default per IP per day for fallback
	if v := os.Getenv("CHUTE_FALLBACK_DAILY_BYTES"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			q = n
		}
	}
	return &Collector{
		byDayIP:  make(map[string]uint64),
		dayQuota: q,
	}
}

func dayKey(ip string) string {
	return time.Now().UTC().Format("2006-01-02") + "|" + ip
}

// AllowFallback returns false when the IP has exceeded the daily byte quota.
func (c *Collector) AllowFallback(ip string, addBytes int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := dayKey(ip)
	used := c.byDayIP[k]
	if used+uint64(addBytes) > c.dayQuota {
		c.FallbackReject.Add(1)
		return false
	}
	c.byDayIP[k] = used + uint64(addBytes)
	c.FallbackBytes.Add(uint64(addBytes))
	return true
}

func (c *Collector) IncRooms() { c.RoomsCreated.Add(1) }
func (c *Collector) IncPeers() { c.PeersJoined.Add(1) }
func (c *Collector) IncTransfers() { c.TransfersDone.Add(1) }

	c.mu.Lock()
	quota := c.dayQuota
	ips := len(c.byDayIP)
	c.mu.Unlock()
	return map[string]any{
		"rooms_created":        c.RoomsCreated.Load(),
		"peers_joined":         c.PeersJoined.Load(),
		"fallback_bytes_total": c.FallbackBytes.Load(),
		"fallback_rejects":     c.FallbackReject.Load(),
		"transfers_done":       c.TransfersDone.Load(),
		"fallback_daily_quota": quota,
		"fallback_ip_days":     ips,
	}
}

func (c *Collector) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(c.Snapshot())
	}
}
