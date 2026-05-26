# Cloud, Country, Friends, And Mail

Goblintown is local-first. Cloud features are optional, and the app asks on
first run whether the Warren should stay local or use Goblintown Cloud.

The first-run choice labels are intentionally blunt:

- **Stay Local** keeps the town on this machine.
- **Use Goblintown Cloud** enables account, friend, country, and mail features.

## Local Only

Local-only mode keeps memory, runs, provider secrets, and reset state on the
machine. Cloud sign-in, public discovery, direct messages, and remote country
metadata stay disabled.

## Goblintown Cloud

Cloud mode uses the bundled Firebase project `goblintown-88fd6` for:

- SSO;
- friend codes;
- country discovery;
- direct messages;
- country metadata.

Local Rite and run files still remain under `.goblintown/`.

Settings path:

```text
Settings -> Account
```

CLI:

```bash
goblintown cloud
```

Forks can override Firebase config with:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_MEASUREMENT_ID`

## Reset

Reset is deliberately buried:

```text
Settings -> Reset -> Asteroid Mode
```

Asteroid Mode can destroy local town state, and with an extra confirmation can
request cloud-data deletion for the signed-in account.

## Goblin-Country

Goblin-Country lets multiple Warrens cooperate.

```bash
goblintown country peer add --name alpha --url http://localhost:7777
goblintown country peer add --name beta --url http://localhost:8888
goblintown country peer ls
goblintown country show
goblintown country run --task "Find schema drift risks" --all --pack 2
```

Country lifecycle in the UI:

- a country identity is auto-created per Warren;
- enable Country Mode from Settings;
- search by country code or discover open countries;
- approve or deny join requests;
- assign creature roles across teammates;
- require teammates online before team Rites/plans run.

## Friends And Mail

Settings -> Mail provides:

- friend requests;
- direct message threads;
- unread markers;
- country-code based friend discovery.
