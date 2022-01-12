#!/usr/bin/env -S node --require ts-node/register/transpile-only --require tsconfig-paths/register

// Copyright © 2021 The Radicle Upstream Contributors
//
// This file is part of radicle-upstream, distributed under the GPLv3
// with Radicle Linking Exception. For full terms see the included
// LICENSE file.

import * as path from "path";
import { strict as strictAssert } from "assert";

import * as source from "proxy-client/source";
import { sleep } from "ui/src/sleep";
import {
  RadicleProxy,
  UpstreamSeed,
  commit,
  getLatestCommitSha,
  pushRad,
  radCli,
  runTestcase,
  withRetry,
} from "./lib/p2p";

// Test that updates to a project from the contributor are replicated back to
// the maintainer via a seed.
//
// This testcase is a variation on contributor-fork-replication-1-test.ts:
// we add a commit to the project on contributor while not connected to the
// seed.
async function testcase(dataPath: string) {
  const project = {
    name: "my-fancy-project",
    urn: "rad:git:hnrkrhhs1goaawo7db1gpyct8hd7mif5q8c3o",
  };

  const seed = new UpstreamSeed({
    name: "seed",
    ipAddress: "10.0.0.1",
    project: project.urn,
    dataPath,
  });

  const maintainer = new RadicleProxy({
    name: "maintainer",
    ipAddress: "10.0.0.101",
    seed: seed.seedAddress,
    dataPath,
  });

  const contributor = new RadicleProxy({
    name: "contributor",
    ipAddress: "10.0.0.102",
    seed: seed.seedAddress,
    dataPath,
  });

  seed.start();
  maintainer.start();

  // Maintainer creates a new project.
  await withRetry(async () => {
    await maintainer.proxyClient.project.create({
      repo: {
        type: "new",
        path: maintainer.checkoutPath,
        name: project.name,
      },
      description: "",
      defaultBranch: "main",
    });
  });

  // Assert that the seed received the project.
  await withRetry(async () => {
    const result = radCli({
      radHome: seed.radHome,
      args: ["identities", "project", "get", "--urn", project.urn],
    });

    strictAssert.deepStrictEqual(result, {
      urn: project.urn,
      payload: {
        "https://radicle.xyz/link/identities/project/v1": {
          name: "my-fancy-project",
          description: "",
          default_branch: "main",
        },
      },
    });
  });

  // Without this the test fails, not sure why.
  await sleep(1000);

  await maintainer.stop();
  contributor.start();

  // Contributor follows the project.
  await withRetry(async () => {
    await contributor.proxyClient.project.requestSubmit(project.urn);
  });

  // Assert that the contributor received the project.
  await withRetry(async () => {
    const result = await contributor.proxyClient.project.get(project.urn);

    strictAssert.deepStrictEqual(result, {
      urn: project.urn,
      metadata: {
        name: project.name,
        description: "",
        defaultBranch: "main",
        maintainers: [maintainer.identityUrn],
      },
      stats: { commits: 1, branches: 0, contributors: 1 },
    });
  });

  // Contributor forks the project.
  const contributorCheckoutPath =
    await contributor.proxyClient.project.checkout(project.urn, {
      path: contributor.checkoutPath,
      peerId: maintainer.peerId,
    });

  await seed.stop();

  // Contributor publishes a new commit.
  commit({
    author: contributor.name,
    checkoutPath: contributorCheckoutPath,
  });
  pushRad({
    radHome: contributor.radHome,
    checkoutPath: contributorCheckoutPath,
    keyPassphrase: contributor.passphrase,
  });

  // We need to restart the contributor after the seed has started so that the
  // contributor reconnects to the seed, otherwise there's a 30sec delay and
  // the test fails.
  await contributor.stop();
  seed.start();
  contributor.start();

  // Assert that the seed received the contributor's fork and latest commit.
  await withRetry(async () => {
    const result = radCli({
      radHome: seed.radHome,
      args: ["identities", "project", "tracked", "--urn", project.urn],
    });

    strictAssert.strictEqual(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any).find((x: any) => x.peerId === contributor.peerId).status
        .user.refs.heads.main,
      getLatestCommitSha(contributorCheckoutPath)
    );
  });
  await contributor.stop();

  maintainer.start();

  // Maintainer adds contributor as a remote to the project.
  await withRetry(async () => {
    await maintainer.proxyClient.project.peerTrack(
      project.urn,
      contributor.peerId
    );
  });

  // Assert that the maintainer found the remote.
  await withRetry(async () => {
    const result = await maintainer.proxyClient.project.listPeers(project.urn);

    strictAssert.strictEqual(
      result.find(x => x.peerId === contributor.peerId)?.status.type,
      "replicated"
    );
  });

  // Assert that the maintainer received the contributor's latest commit.
  await withRetry(async () => {
    const commitList = await maintainer.proxyClient.source.commitsGet({
      projectUrn: project.urn,
      peerId: contributor.peerId,
      revision: { type: source.RevisionType.Branch, name: "main" },
    });

    strictAssert.strictEqual(
      commitList.headers[0].sha1,
      getLatestCommitSha(contributorCheckoutPath)
    );
  });
}

runTestcase({
  testcase,
  networkScript: "star-topology.sh",
  dataDirName: path.basename(__filename).replace(".ts", ""),
});
