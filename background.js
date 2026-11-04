"use strict";

/**
 * Opens the dupes view for the given folder.
 *
 * @param {object|undefined} folder MailFolder to scan
 * @param {number|undefined} mailTabId Mail tab the request came from (for "Show in folder")
 */
async function openDupes(folder, mailTabId) {
  const params = new URLSearchParams();
  if (folder) {
    // Only keep the identifying properties, the object goes into the URL.
    const { id, accountId, path, name } = folder;
    params.set("folder", JSON.stringify({ id, accountId, path, name }));
  }
  if (mailTabId != null) {
    params.set("mailTab", String(mailTabId));
  }
  await browser.tabs.create({ url: browser.runtime.getURL("dupes.html") + "?" + params });
}

/**
 * Resolves the folder displayed in the given tab, or in the active mail tab as fallback.
 */
async function folderFromTab(tab) {
  if (tab) {
    try {
      const mailTab = await browser.mailTabs.get(tab.id);
      if (mailTab?.displayedFolder) {
        return { folder: mailTab.displayedFolder, tabId: mailTab.id };
      }
    } catch (e) {
      // Not a mail tab.
    }
  }
  const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
  return { folder: mailTab?.displayedFolder, tabId: mailTab?.id };
}

browser.browserAction.onClicked.addListener(async (tab) => {
  const { folder, tabId } = await folderFromTab(tab);
  await openDupes(folder, tabId);
});

browser.menus.create({
  id: "show-dupes-list",
  title: "Show dupes",
  contexts: ["message_list"],
});
browser.menus.create({
  id: "show-dupes-folder",
  title: "Show dupes in this folder",
  contexts: ["folder_pane"],
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "show-dupes-folder") {
    const folder = info.selectedFolder ?? info.selectedFolders?.[0];
    await openDupes(folder, tab?.id);
  } else if (info.menuItemId === "show-dupes-list") {
    const { folder, tabId } = await folderFromTab(tab);
    await openDupes(folder, tabId);
  }
});
