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
	mu       sync.Mutex
	writeMu  sync.Mutex
	channels map[string]applicationDataChannel
	output   io.Writer
	closed   bool
	failed   func(error)
	done     chan struct{}
}

func newApplicationBridge(failed func(error)) *applicationBridge {
	bridge := &applicationBridge{channels: map[string]applicationDataChannel{}, output: os.NewFile(4, "station-application-output"), failed: failed, done: make(chan struct{})}
	go bridge.read(os.NewFile(3, "station-application-input"))
	return bridge
}
func (b *applicationBridge) send(packet applicationPacket) {
	b.mu.Lock()
	closed := b.closed
	b.mu.Unlock()
	if closed {
		return
	}
	b.writeMu.Lock()
	err := json.NewEncoder(b.output).Encode(packet)
	b.writeMu.Unlock()
	if err != nil {
		b.failed(errors.New("application IPC write failed"))
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
	b.mu.Lock()
	if b.closed || len(b.channels) >= 32 {
		b.mu.Unlock()
		_ = channel.Close()
		return
	}
	b.channels[id] = channel
	b.mu.Unlock()
	// Publish the ID before registering the message callback; a fast first
	// browser message must not overtake its open packet on the parent pipe.
	b.send(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "open"})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString || len(message.Data) > 48*1024 || !utf8.Valid(message.Data) {
			_ = channel.Close()
			return
		}
		body := string(message.Data)
		b.send(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "message", Body: &body})
	})
	channel.OnClose(func() {
		b.mu.Lock()
		delete(b.channels, id)
		b.mu.Unlock()
		b.send(applicationPacket{Version: "station.lab-ipc/v1", ID: id, Kind: "close"})
	})
}
func (b *applicationBridge) read(input io.ReadCloser) {
	defer close(b.done)
	defer input.Close()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 128*1024)
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
		b.failed(errors.New("application IPC read failed"))
	}
}
func (b *applicationBridge) close() {
	b.mu.Lock()
	b.closed = true
	channels := make([]applicationDataChannel, 0, len(b.channels))
	for _, channel := range b.channels {
		channels = append(channels, channel)
	}
	b.channels = map[string]applicationDataChannel{}
	b.mu.Unlock()
	for _, channel := range channels {
		_ = channel.Close()
	}
}
