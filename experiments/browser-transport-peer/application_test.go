package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type bufferWriteCloser struct{ bytes.Buffer }

func (b *bufferWriteCloser) Close() error { return nil }

type blockingWriteCloser struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
}

type shortWriteCloser struct{}

func (*shortWriteCloser) Write(value []byte) (int, error) { return len(value) - 1, nil }
func (*shortWriteCloser) Close() error                    { return nil }

type observedFileWriter struct {
	*os.File
	entered  chan struct{}
	returned chan struct{}
	once     sync.Once
}

func (w *observedFileWriter) Write(value []byte) (int, error) {
	if len(value) > 100*1024 {
		w.once.Do(func() { close(w.entered) })
	}
	n, err := w.File.Write(value)
	if len(value) > 100*1024 {
		select {
		case <-w.returned:
		default:
			close(w.returned)
		}
	}
	return n, err
}

func (w *blockingWriteCloser) Write([]byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.closed
	return 0, errors.New("closed")
}
func (w *blockingWriteCloser) Close() error {
	select {
	case <-w.closed:
	default:
		close(w.closed)
	}
	return nil
}

type fakeApplicationChannel struct {
	ordered             bool
	maxRetransmits      *uint16
	maxLifetime         *uint16
	buffered            uint64
	messages            []string
	closed              bool
	onMessage           func(webrtc.DataChannelMessage)
	onClose             func()
	sendError           error
	closeOnRegistration bool
}

func (c *fakeApplicationChannel) Ordered() bool              { return c.ordered }
func (c *fakeApplicationChannel) MaxRetransmits() *uint16    { return c.maxRetransmits }
func (c *fakeApplicationChannel) MaxPacketLifeTime() *uint16 { return c.maxLifetime }
func (c *fakeApplicationChannel) OnMessage(callback func(webrtc.DataChannelMessage)) {
	c.onMessage = callback
}
func (c *fakeApplicationChannel) OnClose(callback func()) {
	c.onClose = callback
	if c.closeOnRegistration {
		c.closed = true
		callback()
	}
}
func (c *fakeApplicationChannel) BufferedAmount() uint64 { return c.buffered }
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

func testApplicationBridge(t *testing.T, output io.WriteCloser) *applicationBridge {
	t.Helper()
	done := make(chan struct{})
	close(done)
	bridge := &applicationBridge{
		channels: map[string]applicationDataChannel{}, input: io.NopCloser(strings.NewReader("")), output: output,
		writes: make(chan []byte, 32), stopWriter: make(chan struct{}),
		writerDone: make(chan struct{}), failed: func(error) {}, done: done,
	}
	go bridge.write()
	t.Cleanup(bridge.close)
	return bridge
}

func firstApplicationID(t *testing.T, bridge *applicationBridge) string {
	t.Helper()
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	for id := range bridge.channels {
		return id
	}
	t.Fatal("missing application channel")
	return ""
}

func readApplication(bridge *applicationBridge, input io.ReadCloser) {
	bridge.done = make(chan struct{})
	bridge.read(input)
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
		bridge := testApplicationBridge(t, &bufferWriteCloser{})
		bridge.failed = func(error) { failures++ }
		readApplication(bridge, io.NopCloser(strings.NewReader(input+"\n")))
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
	bridge := testApplicationBridge(t, &bufferWriteCloser{})
	bridge.failed = func(error) { failures++ }
	readApplication(bridge, io.NopCloser(strings.NewReader("{\"version\":\"station.lab-ipc/v1\",\"id\":\"12345678-1234-1234-1234-123456789012\",\"kind\":\"close\"}\n")))
	if failures != 0 || len(bridge.channels) != 0 {
		t.Fatal("late close changed channel state")
	}
	bridge.close()
}

func TestApplicationChannelAdmissionAndFrameBounds(t *testing.T) {
	output := &bufferWriteCloser{}
	bridge := testApplicationBridge(t, output)
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
	output := &bufferWriteCloser{}
	bridge := testApplicationBridge(t, output)
	channel := &fakeApplicationChannel{ordered: true, buffered: 96 * 1024}
	bridge.add(channel)
	id := firstApplicationID(t, bridge)
	message := "x"
	packet, err := json.Marshal(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "message", Body: &message})
	if err != nil {
		t.Fatal(err)
	}
	readApplication(bridge, io.NopCloser(bytes.NewReader(append(packet, '\n'))))
	if !channel.closed || len(channel.messages) != 0 {
		t.Fatal("send queue bound did not retire channel")
	}

	channel = &fakeApplicationChannel{ordered: true, sendError: errors.New("closed")}
	bridge = testApplicationBridge(t, &bufferWriteCloser{})
	bridge.add(channel)
	id = firstApplicationID(t, bridge)
	packet, err = json.Marshal(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "message", Body: &message})
	if err != nil {
		t.Fatal(err)
	}
	readApplication(bridge, io.NopCloser(bytes.NewReader(append(packet, '\n'))))
	if !channel.closed {
		t.Fatal("failed send did not retire channel")
	}
	bridge.close()
	if len(bridge.channels) != 0 {
		t.Fatal("bridge cleanup retained channels")
	}
}

func TestApplicationIPCAdmitsEscapedFrameAtBodyLimit(t *testing.T) {
	output := &bufferWriteCloser{}
	bridge := testApplicationBridge(t, output)
	channel := &fakeApplicationChannel{ordered: true}
	bridge.add(channel)
	id := firstApplicationID(t, bridge)
	body := strings.Repeat("\x00", 48*1024)
	packet, err := json.Marshal(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "message", Body: &body})
	if err != nil {
		t.Fatal(err)
	}
	if len(packet) <= 128*1024 {
		t.Fatal("test did not exercise JSON escape expansion")
	}
	readApplication(bridge, io.NopCloser(bytes.NewReader(append(packet, '\n'))))
	if channel.closed || len(channel.messages) != 1 || channel.messages[0] != body {
		t.Fatal("body-limit frame was lost after JSON escape expansion")
	}
}

func TestApplicationCloseUnblocksOwnedPipeWriter(t *testing.T) {
	output := &blockingWriteCloser{started: make(chan struct{}), closed: make(chan struct{})}
	bridge := testApplicationBridge(t, output)
	bridge.add(&fakeApplicationChannel{ordered: true})
	select {
	case <-output.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not reach blocking pipe")
	}
	settled := make(chan struct{})
	go func() {
		bridge.close()
		close(settled)
	}()
	select {
	case <-settled:
	case <-time.After(time.Second):
		t.Fatal("bridge close did not unblock pipe writer")
	}
}

func TestApplicationCloseUnblocksRealOwnedPipes(t *testing.T) {
	inputReader, inputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		_ = inputReader.Close()
		_ = inputWriter.Close()
		t.Fatal(err)
	}
	defer inputWriter.Close()
	defer outputReader.Close()
	observed := &observedFileWriter{
		File: outputWriter, entered: make(chan struct{}), returned: make(chan struct{}),
	}
	bridge := newApplicationBridgeIO(inputReader, observed, func(error) {})
	channel := &fakeApplicationChannel{ordered: true}
	bridge.add(channel)
	channel.onMessage(webrtc.DataChannelMessage{
		IsString: true,
		Data:     []byte(strings.Repeat("\x00", 48*1024)),
	})
	select {
	case <-observed.entered:
	case <-time.After(time.Second):
		t.Fatal("bridge writer never entered the full kernel pipe")
	}
	select {
	case <-observed.returned:
		t.Fatal("write to the undrained full kernel pipe returned before close")
	default:
	}
	settled := make(chan struct{})
	go func() {
		bridge.close()
		close(settled)
	}()
	select {
	case <-settled:
	case <-time.After(time.Second):
		t.Fatal("bridge close did not join real pipe reader and writer")
	}
}

func TestApplicationOutputQueueRemainsBoundedWhenParentDoesNotDrain(t *testing.T) {
	output := &blockingWriteCloser{started: make(chan struct{}), closed: make(chan struct{})}
	bridge := testApplicationBridge(t, output)
	failed := make(chan error, 1)
	bridge.failed = func(err error) {
		select {
		case failed <- err:
		default:
		}
	}
	channel := &fakeApplicationChannel{ordered: true}
	bridge.add(channel)
	select {
	case <-output.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not reach blocking pipe")
	}
	body := []byte(strings.Repeat("x", 48*1024))
	for range 12 {
		channel.onMessage(webrtc.DataChannelMessage{IsString: true, Data: body})
	}
	select {
	case err := <-failed:
		if !strings.Contains(err.Error(), "queue exceeded bound") {
			t.Fatalf("unexpected queue failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("undrained parent pipe did not hit output queue bound")
	}
}

func TestApplicationShortPipeWriteFailsFixture(t *testing.T) {
	bridge := testApplicationBridge(t, &shortWriteCloser{})
	failed := make(chan error, 1)
	bridge.failed = func(err error) { failed <- err }
	bridge.add(&fakeApplicationChannel{ordered: true})
	select {
	case err := <-failed:
		if err.Error() != "application IPC write failed" {
			t.Fatalf("unexpected short-write failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("short pipe write was accepted")
	}
}

func TestApplicationCloseDuringCallbackRegistrationDoesNotLeak(t *testing.T) {
	bridge := testApplicationBridge(t, &bufferWriteCloser{})
	channel := &fakeApplicationChannel{ordered: true, closeOnRegistration: true}
	bridge.add(channel)
	if len(bridge.channels) != 0 || !channel.closed {
		t.Fatal("channel closed during callback registration was retained")
	}
	bridge.close()
}
