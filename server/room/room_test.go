package room

import "testing"

func TestJoinLeave(t *testing.T) {
	h := NewHub()
	r := h.GetOrCreate("abc")
	a := &Peer{ID: "a", Send: make(chan []byte, 4)}
	b := &Peer{ID: "b", Send: make(chan []byte, 4)}
	c := &Peer{ID: "c", Send: make(chan []byte, 4)}

	if !r.Join(a) || !r.Join(b) {
		t.Fatal("expected first two joins to succeed")
	}
	if r.Join(c) {
		t.Fatal("room should be full")
	}
	if r.Count() != 2 {
		t.Fatalf("count=%d", r.Count())
	}
	r.Leave("a")
	if r.Count() != 1 {
		t.Fatalf("count after leave=%d", r.Count())
	}
	if !r.Join(c) {
		t.Fatal("expected join after leave")
	}
}

func TestBroadcast(t *testing.T) {
	r := &Room{ID: "r", Peers: map[string]*Peer{}}
	a := &Peer{ID: "a", Send: make(chan []byte, 4)}
	b := &Peer{ID: "b", Send: make(chan []byte, 4)}
	r.Join(a)
	r.Join(b)
	r.Broadcast("a", []byte("hi"))
	select {
	case msg := <-b.Send:
		if string(msg) != "hi" {
			t.Fatalf("got %s", msg)
		}
	default:
		t.Fatal("expected message")
	}
	select {
	case <-a.Send:
		t.Fatal("sender should be excluded")
	default:
	}
}
