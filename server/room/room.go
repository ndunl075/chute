package room

import (
	"sync"
	"time"
)

// Peer is a connected client in a room.
type Peer struct {
	ID   string
	Send chan []byte
}

// Room holds up to two peers for a transfer session.
type Room struct {
	ID        string
	Peers     map[string]*Peer
	CreatedAt time.Time
	mu        sync.Mutex
}

// Hub manages all active rooms.
type Hub struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]*Room)}
}

func (h *Hub) GetOrCreate(id string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[id]; ok {
		return r
	}
	r := &Room{
		ID:        id,
		Peers:     make(map[string]*Peer),
		CreatedAt: time.Now(),
	}
	h.rooms[id] = r
	return r
}

func (h *Hub) Get(id string) *Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[id]
}

func (h *Hub) DeleteIfEmpty(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[id]
	if !ok {
		return
	}
	r.mu.Lock()
	empty := len(r.Peers) == 0
	r.mu.Unlock()
	if empty {
		delete(h.rooms, id)
	}
}

// Join adds a peer. Returns false if the room is full (max 2).
func (r *Room) Join(peer *Peer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.Peers) >= 2 {
		return false
	}
	r.Peers[peer.ID] = peer
	return true
}

func (r *Room) Leave(peerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.Peers[peerID]; ok {
		close(p.Send)
		delete(r.Peers, peerID)
	}
}

func (r *Room) PeerIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.Peers))
	for id := range r.Peers {
		ids = append(ids, id)
	}
	return ids
}

func (r *Room) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.Peers)
}

// Broadcast sends msg to every peer except excludeID.
func (r *Room) Broadcast(excludeID string, msg []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, p := range r.Peers {
		if id == excludeID {
			continue
		}
		select {
		case p.Send <- msg:
		default:
			// Drop if peer is slow; avoid blocking the hub.
		}
	}
}

// SendTo delivers msg to a specific peer.
func (r *Room) SendTo(peerID string, msg []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.Peers[peerID]
	if !ok {
		return false
	}
	select {
	case p.Send <- msg:
		return true
	default:
		return false
	}
}
