const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");

function load(source, names, context) {
  for (const name of names) {
    const match = source.match(
      new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m")
    );
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

function fixture({ authResult, authError, openError, openErrorUrl } = {}) {
  const calls = { auth: [], tabs: [] };
  const context = vm.createContext({
    console: { error() {} },
    CHROME_SIGNIN_SETTINGS_URL: "chrome://settings/people",
    GOOGLE_BROWSER_SIGNIN_REQUIRED_CODE: "GOOGLE_BROWSER_SIGNIN_REQUIRED",
    GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED_CODE: "GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED",
    GOOGLE_OAUTH_CLIENTS_URL: "https://console.cloud.google.com/auth/clients",
    CHROME_EXTENSIONS_SETTINGS_URL: "chrome://extensions",
    chrome: {
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        getManifest: () => ({ oauth2: { client_id: "test-client.apps.googleusercontent.com" } })
      },
      identity: {
        async getAuthToken(options) {
          calls.auth.push(options);
          if (authError) throw authError;
          return authResult;
        }
      },
      tabs: {
        async create(options) {
          calls.tabs.push(options);
          if (openError && (!openErrorUrl || openErrorUrl === options.url)) throw openError;
          return { id: 42, ...options };
        }
      }
    }
  });

  load(
    worker,
    [
      "isGoogleBrowserSigninDisabledError",
      "isGoogleOAuthBadClientIdError",
      "openGoogleOAuthClientSettings",
      "directUserToChromeSignin",
      "getGoogleAccessToken"
    ],
    context
  );

  return { calls, context };
}

test("browser-signin-disabled auth failures open Chrome sign-in settings", async () => {
  const { calls, context } = fixture({
    authError: new Error("The user turned off browser signin")
  });

  await assert.rejects(
    context.getGoogleAccessToken(),
    (error) => {
      assert.equal(error.code, "GOOGLE_BROWSER_SIGNIN_REQUIRED");
      assert.match(error.message, /Sign-in settings opened/);
      return true;
    }
  );
  assert.equal(calls.auth.length, 1);
  assert.equal(calls.auth[0].interactive, true);
  assert.equal(calls.tabs.length, 1);
  assert.equal(calls.tabs[0].url, "chrome://settings/people");
  assert.equal(calls.tabs[0].active, true);
});

test("other Google auth failures do not open Chrome settings", async () => {
  const authError = new Error("The user did not approve access.");
  const { calls, context } = fixture({ authError });

  await assert.rejects(context.getGoogleAccessToken(), authError);
  assert.deepEqual(calls.tabs, []);
});

test("a failed settings redirect still tells the user where to sign in", async () => {
  const { context } = fixture({
    authError: new Error("The user turned off browser signin"),
    openError: new Error("Tabs are unavailable")
  });

  await assert.rejects(
    context.getGoogleAccessToken({ interactive: false }),
    (error) => {
      assert.equal(error.code, "GOOGLE_BROWSER_SIGNIN_REQUIRED");
      assert.match(error.message, /chrome:\/\/settings\/people/);
      return true;
    }
  );
});

test("successful Google authorization returns the token without redirecting", async () => {
  const { calls, context } = fixture({ authResult: { token: "test-token" } });

  assert.equal(await context.getGoogleAccessToken(), "test-token");
  assert.deepEqual(calls.tabs, []);
});

for (const authError of [
  new Error("OAuth2 request failed: Service responded with error: 'bad client id: test-client.apps.googleusercontent.com'"),
  "OAuth2 request failed: BAD CLIENT ID: test-client.apps.googleusercontent.com"
]) {
  test(`bad-client-ID failures open both setup tabs and explain the exact configuration: ${typeof authError}`, async () => {
    const { calls, context } = fixture({ authError });
    await assert.rejects(context.getGoogleAccessToken(), (error) => {
      assert.equal(error.code, "GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED");
      assert.equal(error.cause, authError);
      assert.match(error.message, /^Process stopped\./);
      assert.match(error.message, /opened in new tabs/);
      assert.match(error.message, /test-client\.apps\.googleusercontent\.com/);
      assert.match(error.message, /type Chrome Extension/);
      assert.match(error.message, /Item ID must match the installed extension ID: abcdefghijklmnopabcdefghijklmnop/);
      assert.match(error.message, /Developer mode enabled/);
      assert.match(error.message, /oauth2\.client_id in manifest\.json/);
      assert.match(error.message, /Reload the extension and retry/);
      return true;
    });
    assert.equal(calls.auth.length, 1);
    assert.deepEqual(calls.tabs.map((tab) => tab.url), [
      "https://console.cloud.google.com/auth/clients",
      "chrome://extensions"
    ]);
    assert.ok(calls.tabs.every((tab) => tab.active === false));
  });
}

test("failure to open one OAuth setup tab still opens the other and supplies both URLs", async () => {
  const { calls, context } = fixture({
    authError: new Error("bad client id: test-client.apps.googleusercontent.com"),
    openError: new Error("Tab creation blocked"),
    openErrorUrl: "https://console.cloud.google.com/auth/clients"
  });
  await assert.rejects(context.getGoogleAccessToken(), (error) => {
    assert.equal(error.code, "GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED");
    assert.match(error.message, /Could not open both setup tabs automatically/);
    assert.match(error.message, /https:\/\/console\.cloud\.google\.com\/auth\/clients/);
    assert.match(error.message, /chrome:\/\/extensions/);
    assert.match(error.message, /Item ID/);
    return true;
  });
  assert.equal(calls.tabs.length, 2);
  assert.equal(calls.tabs[1].url, "chrome://extensions");
});

test("failure to open both OAuth setup tabs preserves the actionable client error", async () => {
  const { context } = fixture({
    authError: new Error("bad client id: test-client.apps.googleusercontent.com"),
    openError: new Error("Tabs are unavailable")
  });
  await assert.rejects(context.getGoogleAccessToken({ interactive: false }), (error) => {
    assert.equal(error.code, "GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED");
    assert.match(error.message, /Could not open both setup tabs automatically/);
    assert.match(error.message, /create a Chrome Extension client/);
    return true;
  });
});
