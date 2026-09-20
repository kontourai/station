package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

// Application frames use dedicated inherited pipes, never diagnostic stdout.
type applicationPacket struct {
	Version string  `json:"version"`
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Body    *string `json:"body,omitempty"`
}

const (
	applicationIPCPacketBytes = 384 * 1024
	applicationIPCQueueBytes  = 512 * 1024
)

type applicationDataChannel interface {
	Ordered() bool
	MaxRetransmits() *uint16
	MaxPacketLifeTime() *uint16
	OnMessage(func(webrtc.DataChannelMessage))
	OnClose(func())
	BufferedAmount() uint64
	SendText(string) error
	Close() error
}
type applicationBridge struct {
	mu           sync.Mutex
	channels     map[string]applicationDataChannel
	input        io.ReadCloser
	output       io.WriteCloser
	writes       chan []byte
	stopWriter   chan struct{}
	writerDone   chan struct{}
	pendingBytes int
	closed       bool
	failed       func(error)
	done         chan struct{}
}

func newApplicationBridge(failed func(error)) *applicationBridge {
	return newApplicationBridgeIO(
		os.NewFile(3, "station-application-input"),
		os.NewFile(4, "station-application-output"),
		failed,
	)
}
func newApplicationBridgeIO(input io.ReadCloser, output io.WriteCloser, failed func(error)) *applicationBridge {
	bridge := &applicationBridge{
		channels: map[string]applicationDataChannel{}, input: input, output: output,
		writes: make(chan []byte, 32), stopWriter: make(chan struct{}),
		writerDone: make(chan struct{}), failed: failed, done: make(chan struct{}),
	}
	go bridge.write()
	go bridge.read(input)
	return bridge
}
func encodeApplicationPacket(packet applicationPacket) ([]byte, error) {
	encoded, err := json.Marshal(packet)
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}
func (b *applicationBridge) enqueueLocked(encoded []byte) error {
	if b.closed {
		return nil
	}
	if b.pendingBytes+len(encoded) > applicationIPCQueueBytes {
		return errors.New("application IPC output queue exceeded bound")
	}
	select {
	case b.writes <- encoded:
		b.pendingBytes += len(encoded)
		return nil
	default:
		return errors.New("application IPC output queue exhausted")
	}
}
func (b *applicationBridge) send(packet applicationPacket) {
	encoded, err := encodeApplicationPacket(packet)
	if err != nil {
		b.failed(errors.New("application IPC packet encoding failed"))
		return
	}
	b.mu.Lock()
	err = b.enqueueLocked(encoded)
	b.mu.Unlock()
	if err != nil {
		b.failed(err)
	}
}
func (b *applicationBridge) write() {
	defer close(b.writerDone)
	for {
		select {
		case <-b.stopWriter:
			return
		case encoded := <-b.writes:
			b.mu.Lock()
			closed := b.closed
			b.mu.Unlock()
			if closed {
				return
			}
			n, err := b.output.Write(encoded)
			if err == nil && n != len(encoded) {
				err = io.ErrShortWrite
			}
			b.mu.Lock()
			b.pendingBytes -= len(encoded)
			b.mu.Unlock()
			b.mu.Lock()
			closed = b.closed
			b.mu.Unlock()
			if err != nil && !closed {
				b.failed(errors.New("application IPC write failed"))
				return
			}
		}
	}
}
func (b *applicationBridge) add(channel applicationDataChannel) {
	if !channel.Ordered() || channel.MaxRetransmits() != nil || channel.MaxPacketLifeTime() != nil {
		_ = channel.Close()
		return
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		b.failed(errors.New("application channel ID failed"))
		return
	}
	nonce[6] = (nonce[6] & 0x0f) | 0x40
	nonce[8] = (nonce[8] & 0x3f) | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", nonce[0:4], nonce[4:6], nonce[6:8], nonce[8:10], nonce[10:16])
	retired := false
	channel.OnClose(func() {
		b.mu.Lock()
		retired = true
		_, admitted := b.channels[id]
		delete(b.channels, id)
		b.mu.Unlock()
		if admitted {
			b.send(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "close"})
		}
	})
	b.mu.Lock()
	if b.closed || retired || len(b.channels) >= 32 {
		b.mu.Unlock()
		_ = channel.Close()
		return
	}
	b.channels[id] = channel
	open, err := encodeApplicationPacket(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "open"})
	if err == nil {
		err = b.enqueueLocked(open)
	}
	b.mu.Unlock()
	if err != nil {
		b.failed(errors.New("application channel open publication failed"))
		_ = channel.Close()
		return
	}
	// The open packet is queued while admission is locked, so neither a fast
	// message nor a concurrent close can overtake it on the parent pipe.
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString || len(message.Data) > 48*1024 || !utf8.Valid(message.Data) {
			_ = channel.Close()
			return
		}
		b.mu.Lock()
		active := b.channels[id] == channel
		b.mu.Unlock()
		if !active {
			return
		}
		body := string(message.Data)
		b.send(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "message", Body: &body})
	})
}
func (b *applicationBridge) read(input io.ReadCloser) {
	defer close(b.done)
	defer input.Close()
	scanner := bufio.NewScanner(input)
	// A 48 KiB UTF-8 body can expand to six JSON bytes per input byte when it
	// consists entirely of escaped control characters.
	scanner.Buffer(make([]byte, 4096), applicationIPCPacketBytes)
	for scanner.Scan() {
		if !utf8.Valid(scanner.Bytes()) {
			b.failed(errors.New("application IPC encoding invalid"))
			return
		}
		var packet applicationPacket
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&packet); err != nil || decoder.Decode(new(any)) != io.EOF || packet.Version != "station.lab-ipc/v1" || len(packet.ID) != 36 || (packet.Kind != "close" && packet.Kind != "message") || (packet.Kind == "close" && packet.Body != nil) || (packet.Kind == "message" && (packet.Body == nil || len(*packet.Body) > 48*1024)) {
			b.failed(errors.New("application IPC packet invalid"))
			return
		}
		b.mu.Lock()
		channel := b.channels[packet.ID]
		b.mu.Unlock()
		if channel == nil {
			continue // Late packets cannot recreate a retired channel.
		}
		if packet.Kind == "close" {
			_ = channel.Close()
			continue
		}
		if channel.BufferedAmount()+uint64(len(*packet.Body)) > 96*1024 {
			_ = channel.Close()
			continue
		}
		if err := channel.SendText(*packet.Body); err != nil {
			_ = channel.Close()
		}
	}
	if scanner.Err() != nil {
		b.mu.Lock()
		closed := b.closed
		b.mu.Unlock()
		if !closed {
			b.failed(errors.New("application IPC read failed"))
		}
	}
}
func (b *applicationBridge) close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	channels := make([]applicationDataChannel, 0, len(b.channels))
	for _, channel := range b.channels {
		channels = append(channels, channel)
	}
	b.channels = map[string]applicationDataChannel{}
	close(b.stopWriter)
	b.mu.Unlock()
	_ = b.input.Close()
	_ = b.output.Close()
	for _, channel := range channels {
		_ = channel.Close()
	}
	<-b.writerDone
	<-b.done
}
