import { readFileSync } from 'node:fs';

// DraftGo deploys the service as a single Go file.
const script = readFileSync(new URL('../../install-server.sh', import.meta.url), 'utf8');

process.stdout.write(`package main

import (
	"net/http"

	"draftgo/sdk"
)

func Register(app *sdk.App) {
	app.Stream("GET", "/linux.sh", downloadInstaller)
}

func downloadInstaller(ctx *sdk.Context) (any, error) {
	stream, err := ctx.Stream(http.StatusOK, http.Header{
		"Content-Type": {"text/plain; charset=utf-8"},
		"Content-Disposition": {"attachment; filename=install-server.sh"},
		"Cache-Control": {"no-cache"},
	})
	if err != nil {
		return nil, err
	}
	_, err = stream.Write([]byte(installer))
	return nil, err
}

const installer = ${JSON.stringify(script)}
`);
