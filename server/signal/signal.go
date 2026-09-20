package signal

import (
	"encoding/json"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/ndunl075/chute/server/room"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

var peerSeq atomic.Uint64

// Message is the wire format for signaling. File bytes never appear here.
type Message struct {
	Type      string          `json:"type"`
	Room      string          `json:"room,omitempty"`
	PeerID    string          `json:"peerId,omitempty"`
	Target    string          `json:"target,omitempty"`
	Peers     []string        `json:"peers,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Error     string          `json:"error,omitempty"`
	Connected int             `json:"connected,omitempty"`
}

type HubHandler struct {
	Hub *room.Hub
}

func (h *HubHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	peerID := nextPeerID()
	peer := &room.Peer{
		ID:   peerID,
		Send: make(chan []byte, 64),
	}

	var currentRoom *room.Room

	done := make(chan struct{})
	go writePump(conn, peer, done)

	defer func() {
		close(done)
		if currentRoom != nil {
			currentRoom.Leave(peerID)
			notifyPeerLeft(currentRoom, peerID)
			h.Hub.DeleteIfEmpty(currentRoom.ID)
		}
		conn.Close()
	}()

	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	welcome, _ := json.Marshal(Message{Type: "welcome", PeerID: peerID})
	peer.Send <- welcome

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			sendErr(peer, "invalid json")
			continue
		}

		switch msg.Type {
		case "join":
			if msg.Room == "" {
				sendErr(peer, "room required")
				continue
			}
			if currentRoom != nil {
				sendErr(peer, "already in a room")
				continue
			}
			r := h.Hub.GetOrCreate(msg.Room)
			if !r.Join(peer) {
				sendErr(peer, "room full")
				continue
			}
			currentRoom = r
			joined, _ := json.Marshal(Message{
				Type:      "joined",
				Room:      r.ID,
				PeerID:    peerID,
				Peers:     otherPeers(r, peerID),
				Connected: r.Count(),
			})
			peer.Send <- joined

			// Notify existing peer(s) that someone joined so they can start offer.
			announce, _ := json.Marshal(Message{
				Type:      "peer-joined",
				PeerID:    peerID,
				Connected: r.Count(),
			})
			r.Broadcast(peerID, announce)

		case "signal":
			if currentRoom == nil {
				sendErr(peer, "not in a room")
				continue
			}
			out, _ := json.Marshal(Message{
				Type:    "signal",
				PeerID:  peerID,
				Target:  msg.Target,
				Payload: msg.Payload,
			})
			if msg.Target != "" {
				if !currentRoom.SendTo(msg.Target, out) {
					sendErr(peer, "target not found")
				}
			} else {
				currentRoom.Broadcast(peerID, out)
			}

		case "ping":
			pong, _ := json.Marshal(Message{Type: "pong"})
			peer.Send <- pong

		default:
			sendErr(peer, "unknown type")
		}
	}
}

func writePump(conn *websocket.Conn, peer *room.Peer, done <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case msg, ok := <-peer.Send:
			if !ok {
				_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func sendErr(peer *room.Peer, text string) {
	b, _ := json.Marshal(Message{Type: "error", Error: text})
	select {
	case peer.Send <- b:
	default:
	}
}

func notifyPeerLeft(r *room.Room, peerID string) {
	msg, _ := json.Marshal(Message{
		Type:      "peer-left",
		PeerID:    peerID,
		Connected: r.Count(),
	})
	r.Broadcast(peerID, msg)
}

func otherPeers(r *room.Room, self string) []string {
	ids := r.PeerIDs()
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != self {
			out = append(out, id)
		}
	}
	return out
}

func nextPeerID() string {
	n := peerSeq.Add(1)
	return "p" + itoa(n)
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
