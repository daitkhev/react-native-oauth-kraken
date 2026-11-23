import { act, renderHook } from '@testing-library/react-native';
import { useAuthRequest } from 'expo-auth-session';

import { signInWithOAuthAuthorizationCode, useSignInOAuth } from './sign-in';
import { SignInOAuthConfig } from './sign-in.types';

jest.mock('expo-auth-session', () => ({
  ...jest.requireActual('expo-auth-session'),
  useAuthRequest: jest.fn(),
}));

const mockUseAuthRequest = useAuthRequest as unknown as jest.Mock;

const TOKEN_ENDPOINT = 'https://api.kraken.com/oauth/token';

const makeConfig = (
  overrides: Partial<SignInOAuthConfig> = {}
): SignInOAuthConfig => ({
  clientId: 'test-client-id',
  redirectUri: 'https://example-domain.com/oauth/callback/my-app',
  scopes: ['account.info:basic'],
  discovery: {
    authorizationEndpoint: 'https://id.kraken.com/oauth/authorize',
    tokenEndpoint: TOKEN_ENDPOINT,
  },
  ...overrides,
});

const makeRequest = (overrides: Record<string, unknown> = {}) => ({
  state: 'test-csrf-state',
  codeVerifier: 'test-code-verifier',
  promptAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
  ...overrides,
});

const callSignIn = async (config: SignInOAuthConfig) => {
  const { result } = renderHook(() => useSignInOAuth(config));
  const response = await act(async () => result.current.signIn());
  return { response, result };
};

let consoleErrorSpy: jest.SpyInstance;
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  fetchSpy = jest.spyOn(global, 'fetch' as any);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  fetchSpy.mockRestore();
});

// Must stay first: module level state is empty until the hook populates it.
describe('signInWithOAuthAuthorizationCode without config', () => {
  it('throws when the global config was never populated', async () => {
    await expect(
      signInWithOAuthAuthorizationCode('code', 'state')
    ).rejects.toThrow('No globalSignInOAuthConfig');
  });
});

describe('useSignInOAuth', () => {
  it('returns an error when the auth request is still loading', async () => {
    mockUseAuthRequest.mockReturnValue([null, null, jest.fn()]);

    const { response, result } = await callSignIn(makeConfig());

    expect(response).toStrictEqual({
      error: 'Request is still loading, try again later',
    });
    expect(result.current.isLoading).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs and returns an error for an invalid redirectUri', async () => {
    mockUseAuthRequest.mockReturnValue([makeRequest(), null, jest.fn()]);
    const redirectUri = 'myapp://oauth/callback';

    const { response } = await callSignIn(makeConfig({ redirectUri }));

    expect(response).toStrictEqual({
      error:
        'Invalid redirectUri, it must be a valid https universal link and app link',
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'OAuth invalid redirectUri error',
      { extra: { redirectUri } }
    );
  });

  it('returns Unknown error with the original value when a non-Error is thrown', async () => {
    const request = makeRequest({
      promptAsync: jest.fn().mockRejectedValue('boom'),
    });
    mockUseAuthRequest.mockReturnValue([request, null, jest.fn()]);

    const { response, result } = await callSignIn(makeConfig());

    expect(response).toStrictEqual({
      error: 'Unknown error',
      originalError: 'boom',
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith('OAuth sign in error', {
      error: 'boom',
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('returns the message and original error when an Error is thrown', async () => {
    const thrown = new Error('prompt failed');
    const request = makeRequest({
      promptAsync: jest.fn().mockRejectedValue(thrown),
    });
    mockUseAuthRequest.mockReturnValue([request, null, jest.fn()]);

    const { response } = await callSignIn(makeConfig());

    expect(response).toStrictEqual({
      error: 'prompt failed',
      originalError: thrown,
    });
  });

  it('passes the discovery document to promptAsync', async () => {
    const request = makeRequest();
    mockUseAuthRequest.mockReturnValue([request, null, jest.fn()]);
    const config = makeConfig();

    await callSignIn(config);

    expect(request.promptAsync).toHaveBeenCalledWith(config.discovery);
  });

  it('passes the config without discovery to useAuthRequest', async () => {
    mockUseAuthRequest.mockReturnValue([null, null, jest.fn()]);
    const config = makeConfig();

    renderHook(() => useSignInOAuth(config));

    expect(mockUseAuthRequest).toHaveBeenCalledWith(
      {
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
      },
      config.discovery
    );
  });

  it('fails when the token endpoint disappears before the code exchange', async () => {
    let reads = 0;
    const discovery = {
      authorizationEndpoint: 'https://id.kraken.com/oauth/authorize',
      get tokenEndpoint() {
        reads += 1;
        return reads === 1 ? TOKEN_ENDPOINT : undefined;
      },
    };
    const request = makeRequest({
      promptAsync: jest.fn().mockResolvedValue({
        type: 'success',
        params: { code: 'abc', state: 'test-csrf-state' },
      }),
    });
    mockUseAuthRequest.mockReturnValue([request, null, jest.fn()]);

    const { response } = await callSignIn(makeConfig({ discovery }));

    expect(response).toMatchObject({ error: 'No discovery token endpoint' });
    expect((response as { originalError: unknown }).originalError).toEqual(
      new Error('No discovery token endpoint')
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sets isLoading back to false after a flow completes', async () => {
    mockUseAuthRequest.mockReturnValue([makeRequest(), null, jest.fn()]);

    const { response, result } = await callSignIn(makeConfig());

    expect(response).toStrictEqual({ error: 'UserCancelled' });
    expect(result.current.isLoading).toBe(false);
  });
});

describe('signInWithOAuthAuthorizationCode with config', () => {
  const populateGlobalConfig = async () => {
    mockUseAuthRequest.mockReturnValue([makeRequest(), null, jest.fn()]);
    await callSignIn(makeConfig());
  };

  it('posts the expected request to the token endpoint', async () => {
    await populateGlobalConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok' }),
    });

    const result = await signInWithOAuthAuthorizationCode(
      'the-code',
      'test-csrf-state'
    );

    expect(result).toStrictEqual({ data: { accessToken: 'tok' } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toStrictEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from('test-client-id:').toString(
        'base64'
      )}`,
    });
    const body = new URLSearchParams(init.body);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(
      'https://example-domain.com/oauth/callback/my-app'
    );
    expect(body.get('code_verifier')).toBe('test-code-verifier');
  });

  it('rejects when the token endpoint responds with a failure', async () => {
    await populateGlobalConfig();
    fetchSpy.mockResolvedValue({ ok: false, json: async () => ({}) });

    await expect(
      signInWithOAuthAuthorizationCode('the-code', 'test-csrf-state')
    ).rejects.toThrow('Failed to get access token');
  });
});
