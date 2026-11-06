package indexing

import (
	"context"
	"database/sql"
	"encoding/gob"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/derived"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type pendingDelivery struct {
	Work, Empty, Authority     *catalog.PreparedWork
	Platform, Key, Fingerprint string
	Complete                   bool
	Bytes                      int64
}

func storedMessage(m message) pendingDelivery {
	return pendingDelivery{m.work, m.empty, m.authority, m.platform, m.key, m.fingerprint, m.complete, m.bytes}
}
func (m pendingDelivery) message() message {
	return message{work: m.Work, empty: m.Empty, authority: m.Authority, platform: m.Platform, key: m.Key, fingerprint: m.Fingerprint, complete: m.Complete, bytes: m.Bytes}
}

// HDD reading follows physical location. Future authors are spooled on the
// instance disk so display order need not force source seeks or unbounded RAM.
type deliveryQueue struct {
	p       *Pipeline
	ctx     context.Context
	listing *library.Listing
	output  chan<- message
}

func newDeliveryQueue(ctx context.Context, p *Pipeline, l *library.Listing, output chan<- message) (*deliveryQueue, error) {
	ctx = context.WithoutCancel(ctx)
	_, err := l.DB.ExecContext(ctx, `CREATE TABLE pending_delivery(ordinal INTEGER PRIMARY KEY,platform TEXT,author TEXT,file TEXT);
CREATE INDEX pending_author ON pending_delivery(platform,author,ordinal);
CREATE TABLE author_delivery(platform TEXT,key TEXT,rank INTEGER,done INTEGER DEFAULT 0,PRIMARY KEY(platform,key));`)
	if err != nil {
		return nil, err
	}
	for _, id := range p.selected {
		if cap(p.disks[p.Config.Sources[id]]) != 1 {
			continue
		}
		if _, err = l.DB.ExecContext(ctx, `INSERT INTO author_delivery(platform,key,rank) SELECT platform,key,row_number() OVER(ORDER BY (SELECT count(*) FROM entries w WHERE w.platform=e.platform AND w.parent=e.key AND w.kind='folder'),key) FROM entries e WHERE platform=? AND parent='.' AND kind='folder' AND (?='' OR key=lower(?))`, id, p.AuthorDirectoryName, p.AuthorDirectoryName); err != nil {
			return nil, err
		}
	}
	return &deliveryQueue{p, ctx, l, output}, nil
}

func (d *deliveryQueue) head(id string) (string, error) {
	ctx, l := d.ctx, d.listing
	var key string
	err := l.DB.QueryRowContext(ctx, "SELECT key FROM author_delivery WHERE platform=? AND done=0 ORDER BY rank LIMIT 1", id).Scan(&key)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return key, err
}

func (d *deliveryQueue) forward(m message) error {
	ctx, l := d.ctx, d.listing
	if m.work == nil && m.complete {
		_, err := l.DB.ExecContext(ctx, "UPDATE author_delivery SET done=1 WHERE platform=? AND key=?", m.platform, m.key)
		if err != nil {
			return err
		}
	}
	d.output <- m
	return nil
}

func (d *deliveryQueue) drain(id string, all bool) error {
	ctx, l, p := d.ctx, d.listing, d.p
	for {
		key, err := d.head(id)
		if err != nil {
			return err
		}
		query := "SELECT ordinal,file FROM pending_delivery WHERE platform=?"
		args := []any{id}
		if !all {
			query += " AND author=?"
			args = append(args, key)
		}
		var ordinal int64
		var file string
		err = l.DB.QueryRowContext(ctx, query+" ORDER BY ordinal LIMIT 1", args...).Scan(&ordinal, &file)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		f, err := os.Open(file)
		if err != nil {
			return err
		}
		var stored pendingDelivery
		err = errors.Join(gob.NewDecoder(f).Decode(&stored), f.Close())
		if err != nil {
			return err
		}
		if err = p.queueBudget.Acquire(ctx, stored.Bytes); err != nil {
			return err
		}
		if err = d.forward(stored.message()); err != nil {
			p.discardMessage(stored.message())
			return err
		}
		if _, err = l.DB.ExecContext(ctx, "DELETE FROM pending_delivery WHERE ordinal=?", ordinal); err != nil {
			return err
		}
		if err = derived.Remove(file); err != nil {
			return err
		}
	}
}

func (d *deliveryQueue) store(m message) (result error) {
	author := m.key
	if m.work != nil {
		author = m.work.AuthorKey
	}
	ctx, l, p := d.ctx, d.listing, d.p
	at := time.Now()
	f, err := os.CreateTemp(filepath.Join(p.Config.InstanceRoot, "temp"), "pending-delivery-*.gob")
	if err != nil {
		return err
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, derived.Remove(f.Name()))
		}
	}()
	err = errors.Join(gob.NewEncoder(f).Encode(storedMessage(m)), f.Close())
	if err != nil {
		return err
	}
	if _, err = l.DB.ExecContext(ctx, "INSERT INTO pending_delivery(platform,author,file) VALUES (?,?,?)", m.platform, author, f.Name()); err != nil {
		return err
	}
	p.queueBudget.Release(m.bytes)
	p.c.SpoolNanos.Add(time.Since(at).Nanoseconds())
	return nil
}

func (p *Pipeline) discardMessage(m message) error {
	p.queueBudget.Release(m.bytes)
	if m.work != nil {
		return catalog.ReleasePrepared(*m.work)
	}
	return nil
}
func (d *deliveryQueue) accept(m message) (result error) {
	defer func() {
		if result != nil {
			result = errors.Join(result, d.p.discardMessage(m))
		}
	}()
	if cap(d.p.disks[d.p.Config.Sources[m.platform]]) != 1 {
		d.output <- m
		return nil
	}
	if m.finished != nil {
		if err := d.drain(m.platform, true); err != nil {
			return err
		}
		d.output <- m
		return nil
	}
	author := m.key
	if m.work != nil {
		author = m.work.AuthorKey
	}
	key, err := d.head(m.platform)
	if err != nil {
		return err
	}
	if author == key || key == "" {
		if err = d.forward(m); err != nil {
			return err
		}
		m.bytes = 0
		m.work = nil
		if err = d.drain(m.platform, false); err != nil {
			return err
		}
		return nil
	}
	return d.store(m)
}

func (p *Pipeline) orderMessages(ctx context.Context, l *library.Listing, input <-chan message, output chan<- message) error {
	d, err := newDeliveryQueue(ctx, p, l, output)
	if err != nil {
		return err
	}
	for m := range input {
		if err = d.accept(m); err != nil {
			return err
		}
	}
	for _, id := range p.selected {
		if err = d.drain(id, true); err != nil {
			return err
		}
	}
	return nil
}
