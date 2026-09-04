# Temple Keeper web client

Angular client for the Temple Keeper ticket gate and desktop administration screens.

- API prefix: `/bcn/templekeeper/`
- Browser administration authenticates with the HttpOnly `tk_session` cookie.
- Gate scans are stored locally first, then synchronized through roster versions, scan feeds, and append-only scan batches.

## Development

```bash
npm start
```

The dev proxy forwards `/bcn/templekeeper/` to `https://nim.io.vn`.

## Verify production build

```bash
npm run build
```
