import { afterEach, describe, expect, it, vi } from "vitest";
import { syncSerialList } from "../src/cloudflare-list";

const env = { CLOUDFLARE_API_TOKEN: "secret-token" };

const config = {
  cloudflareAccountId: "account-1",
  serialListId: "list-1",
  maxContentAgeDays: 7,
  listMaxItems: 1000,
};

function reply(
  items: Array<string | { value: string; description?: string }>,
): Response {
  return Response.json({
    success: true,
    errors: [],
    result: {
      id: "list-1",
      name: "Cortex noncompliant devices",
      type: "SERIAL",
      count: items.length,
      items: items.map((item) =>
        typeof item === "string" ? { value: item } : item,
      ),
    },
  });
}

function metadataReply(): Response {
  return Response.json({
    success: true,
    errors: [],
    result: {
      id: "list-1",
      name: "Cortex noncompliant devices",
      type: "SERIAL",
      count: 1,
    },
  });
}

function itemsReply(items: string[]): Response {
  return Response.json({
    success: true,
    errors: [],
    result: items.map((value) => ({ value })),
  });
}

function successReply(): Response {
  return Response.json({ success: true, errors: [] });
}

function decision(serialNumber: string, noncompliant = true) {
  return { serialNumber, noncompliant };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare serial denylist", () => {
  it("does not update an unchanged normalized list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(["SERIAL-1", "SERIAL-2"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncSerialList(
        [decision(" SERIAL-2 "), decision("SERIAL-1")],
        env,
        config,
      ),
    ).resolves.toEqual({ changed: false, count: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replaces the list and verifies the response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(["OLD-SERIAL"]))
      .mockResolvedValueOnce(successReply())
      .mockResolvedValueOnce(reply(["SERIAL-1", "SERIAL-2"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncSerialList(
        [
          decision("OLD-SERIAL", false),
          decision("SERIAL-2"),
          decision("SERIAL-1"),
        ],
        env,
        config,
      ),
    ).resolves.toEqual({ changed: true, count: 2 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.cloudflare.com/client/v4/accounts/account-1/gateway/lists/list-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          name: "Cortex noncompliant devices",
          description:
            "Cortex endpoints with stale security content; managed by Worker",
          items: [{ value: "SERIAL-1" }, { value: "SERIAL-2" }],
        }),
      }),
    );
  });

  it("uses a nonmatching sentinel for an empty denylist", async () => {
    const sentinel = "__cortex_no_noncompliant_devices__";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(["OLD-SERIAL"]))
      .mockResolvedValueOnce(reply([sentinel]))
      .mockResolvedValueOnce(
        reply([
          {
            value: sentinel,
            description: "No noncompliant Cortex devices",
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncSerialList([decision("OLD-SERIAL", false)], env, config),
    ).resolves.toEqual({
      changed: true,
      count: 0,
    });
  });

  it("preserves existing membership when no fresh decision is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(["SERIAL-1"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncSerialList([], env, config)).resolves.toEqual({
      changed: false,
      count: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the dedicated items endpoint when list details omit items", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(metadataReply())
      .mockResolvedValueOnce(itemsReply(["SERIAL-1"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncSerialList([], env, config)).resolves.toEqual({
      changed: false,
      count: 1,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-1/gateway/lists/list-1/items",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("publishes hostname and MAC as the serial item description", async () => {
    const description = "hostname=laptop-1; mac=aa:bb:cc:dd:ee:ff";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(["SERIAL-1"]))
      .mockResolvedValueOnce(successReply())
      .mockResolvedValueOnce(reply([{ value: "SERIAL-1", description }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncSerialList(
        [{ serialNumber: "SERIAL-1", noncompliant: true, description }],
        env,
        config,
      ),
    ).resolves.toEqual({ changed: true, count: 1 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining(description),
      }),
    );
  });

  it("refuses to publish more than the configured capacity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply([])));
    await expect(
      syncSerialList(
        [decision("A"), decision("B")],
        env,
        { ...config, listMaxItems: 1 },
      ),
    ).rejects.toThrow("exceeds configured list limit");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a list with the wrong type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          result: {
            id: "list-1",
            name: "Cortex noncompliant devices",
            type: "DEVICE",
            items: [],
          },
        }),
      ),
    );
    await expect(
      syncSerialList([decision("SERIAL-1")], env, config),
    ).rejects.toThrow("must have type SERIAL");
  });
});
