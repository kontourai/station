package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

type fakeApplicationChannel struct {
	ordered        bool
	maxRetransmits *uint16
	maxLifetime    *uint16
	buffered       uint64
	messages       []string
	closed         bool
	onMessage      func(webrtc.DataChannelMessage)
	onClose        func()
	sendError      error
}

func (c *fakeApplicationChannel) Ordered() bool              { return c.ordered }
func (c *fakeApplicationChannel) MaxRetransmits() *uint16    { return c.maxRetransmits }
func (c *fakeApplicationChannel) MaxPacketLifeTime() *uint16 { return c.maxLifetime }
func (c *fakeApplicationChannel) OnMessage(callback func(webrtc.DataChannelMessage)) {
	c.onMessage = callback
}
func (c *fakeApplicationChannel) OnClose(callback func()) { c.onClose = callback }
func (c *fakeApplicationChannel) BufferedAmount() uint64  { return c.buffered }
func (c *fakeApplicationChannel) SendText(message string) error {
	if c.sendError != nil {
		return c.sendError
	}
	c.messages = append(c.messages, message)
	return nil
}
func (c *fakeApplicationChannel) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	if c.onClose != nil {
		c.onClose()
	}
	return nil
}

func testApplicationBridge(output io.Writer) *applicationBridge {
	return &applicationBridge{channels: map[string]applicationDataChannel{}, output: output, failed: func(error) {}, done: make(chan struct{})}
}

func TestApplicationIPCRejectsMalformedPackets(t *testing.T) {
	for _, input := range []string{
		`{"version":"foreign","id":"12345678-1234-1234-1234-123456789012","kind":"close"}`,
		`{"version":"station.lab-ipc/v1","id":"12345678-1234-1234-1234-123456789012","kind":"open"}`,
		`{"version":"station.lab-ipc/v1","id":"12345678-1234-1234-1234-123456789012","kind":"message"}`,
		`{"version":"station.lab-ipc/v1","id":"12345678-1234-1234-1234-123456789012","kind":"close","body":"not allowed"}`,
		`{"version":"station.lab-ipc/v1","id":"12345678-1234-1234-1234-123456789012","kind":"close","extra":true}`,
		`{"version":"station.lab-ipc/v1","id":"12345678-1234-1234-1234-123456789012","kind":"close"} {}`,
		string([]byte{0xff}), strings.Repeat("x", 128*1024+1),
	} {
		failures := 0
		bridge := &applicationBridge{channels: map[string]applicationDataChannel{}, output: &bytes.Buffer{}, failed: func(error) { failures++ }, done: make(chan struct{})}
		bridge.read(io.NopCloser(strings.NewReader(input + "\n")))
		if failures != 1 {
			t.Fatalf("malformed packet did not produce one refusal: %d", failures)
		}
		select {
		case <-bridge.done:
		default:
			t.Fatal("reader did not settle")
		}
	}
}
func TestApplicationIPCLateCloseCannotReopenChannel(t *testing.T) {
	failures := 0
	bridge := &applicationBridge{channels: map[string]applicationDataChannel{}, output: &bytes.Buffer{}, failed: func(error) { failures++ }, done: make(chan struct{})}
	bridge.read(io.NopCloser(strings.NewReader("{\"version\":\"station.lab-ipc/v1\",\"id\":\"12345678-1234-1234-1234-123456789012\",\"kind\":\"close\"}\n")))
	if failures != 0 || len(bridge.channels) != 0 {
		t.Fatal("late close changed channel state")
	}
	bridge.close()
}

func TestApplicationChannelAdmissionAndFrameBounds(t *testing.T) {
	output := &bytes.Buffer{}
	bridge := testApplicationBridge(output)
	channels := make([]*fakeApplicationChannel, 33)
	for i := range channels {
		channels[i] = &fakeApplicationChannel{ordered: true}
		bridge.add(channels[i])
	}
	if len(bridge.channels) != 32 || !channels[32].closed {
		t.Fatal("channel admission bound was not enforced")
	}
	first := channels[0]
	first.onMessage(webrtc.DataChannelMessage{IsString: true, Data: []byte(strings.Repeat("a", 48*1024))})
	if first.closed {
		t.Fatal("48 KiB application frame was refused")
	}
	first.onMessage(webrtc.DataChannelMessage{IsString: true, Data: []byte(strings.Repeat("a", 48*1024+1))})
	if !first.closed {
		t.Fatal("oversized application frame was accepted")
	}
	unordered := &fakeApplicationChannel{}
	bridge.add(unordered)
	if !unordered.closed {
		t.Fatal("unordered application channel was accepted")
	}
}

func TestApplicationSendQueueAndCleanup(t *testing.T) {
	output := &bytes.Buffer{}
	bridge := testApplicationBridge(output)
	channel := &fakeApplicationChannel{ordered: true, buffered: 96 * 1024}
	bridge.add(channel)
	var opened applicationPacket
	if err := json.NewDecoder(output).Decode(&opened); err != nil {
		t.Fatal(err)
	}
	message := "x"
	packet, err := json.Marshal(applicationPacket{Version: "station.lab-ipc/v1", ID: opened.ID, Kind: "message", Body: &message})
	if err != nil {
		t.Fatal(err)
	}
	bridge.read(io.NopCloser(bytes.NewReader(append(packet, '\n'))))
	if !channel.closed || len(channel.messages) != 0 {
		t.Fatal("send queue bound did not retire channel")
	}

	channel = &fakeApplicationChannel{ordered: true, sendError: errors.New("closed")}
	bridge = testApplicationBridge(&bytes.Buffer{})
	bridge.add(channel)
	for id := range bridge.channels {
		packet, err = json.Marshal(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "message", Body: &message})
		if err != nil {
			t.Fatal(err)
		}
	}
	bridge.read(io.NopCloser(bytes.NewReader(append(packet, '\n'))))
	if !channel.closed {
		t.Fatal("failed send did not retire channel")
	}
	bridge.close()
	if len(bridge.channels) != 0 {
		t.Fatal("bridge cleanup retained channels")
	}
}
