//
// This controls the contents of the Vomnibar iframe. We use an iframe to avoid changing the
// selection on the page (useful for bookmarklets), ensure that the Vomnibar style is unaffected by
// the page, and simplify key handling in vimium_frontend.js
//

import "../lib/types.js";
import "../lib/utils.js";
import "../lib/url_utils.js";
import "../lib/settings.js";
import "../lib/keyboard_utils.js";
import "../lib/dom_utils.js";
import "../lib/handler_stack.js";
import * as UIComponentMessenger from "./ui_component_messenger.js";
import * as userSearchEngines from "../background_scripts/user_search_engines.js";

export let ui; // An instance of VomnibarUI.

// Used for tests.
export function reset() {
  ui = null;
}

export async function activate(options) {
  Utils.assertType(VomnibarShowOptions, options || {});
  await Settings.onLoaded();
  userSearchEngines.set(Settings.get("searchEngines"));

  const defaults = {
    completer: "omni",
    query: "",
    newTab: false,
    selectFirst: false,
    keyword: null,
  };

  options = Object.assign(defaults, options);

  if (ui == null) {
    ui = new VomnibarUI();
  }
  ui.setCompleterName(options.completer);
  ui.refreshCompletions();
  ui.setInitialSelectionValue(options.selectFirst ? 0 : -1);
  ui.setForceNewTab(options.newTab);
  ui.setQuery(options.query);
  ui.setActiveUserSearchEngine(userSearchEngines.keywordToEngine[options.keyword]);
  // Use await here for vomnibar_test.js, so that this page doesn't get unloaded while a test is
  // running.
  await ui.update();
}

class VomnibarUI {
  constructor() {
    this.onKeyEvent = this.onKeyEvent.bind(this);
    this.onInput = this.onInput.bind(this);
    this.update = this.update.bind(this);
    this.onHiddenCallback = null;
    this.initDom();
    // The user's custom search engine, if they have prefixed their query with the keyword for one
    // of their search engines.
    this.activeUserSearchEngine = null;
    // Used for synchronizing requests and responses to the background page.
    this.lastRequestId = null;
  }

  setQuery(query) {
    this.input.value = query;
  }
  setActiveUserSearchEngine(userSearchEngine) {
    this.activeUserSearchEngine = userSearchEngine;
  }

  setInitialSelectionValue(initialSelectionValue) {
    this.initialSelectionValue = initialSelectionValue;
  }
  setForceNewTab(forceNewTab) {
    this.forceNewTab = forceNewTab;
  }
  setCompleterName(name) {
    this.completerName = name;
    this.reset();
  }

  // True if the user has entered the keyword of one of their custom search engines.
  isUserSearchEngineActive() {
    return this.activeUserSearchEngine != null;
  }

  // The sequence of events when the vomnibar is hidden:
  // 1. Post a "hide" message to the host page.
  // 2. The host page hides the vomnibar.
  // 3. When that page receives the focus, it posts back a "hidden" message.
  // 4. Only once the "hidden" message is received here is onHiddenCallback called.
  //
  // This ensures that the vomnibar is actually hidden before any new tab is created, and avoids
  // flicker after opening a link in a new tab then returning to the original tab. See #1485.
  hide(onHiddenCallback = null) {
    this.onHiddenCallback = onHiddenCallback;
    this.input.blur();
    this.reset();
    // Wait until this iframe's DOM has been rendered before hiding the iframe. This is to prevent
    // Chrome caching the previous visual state of the vomnibar iframe. See #4708.
    setTimeout(() => {
      UIComponentMessenger.postMessage({ name: "hide" });
    }, 0);
  }

  onHidden() {
    this.onHiddenCallback?.();
    this.onHiddenCallback = null;
    this.reset();
  }

  reset() {
    this.input.value = "";
    this.completions = [];
    this.renderCompletions(this.completions);
    this.previousInputValue = null;
    this.activeUserSearchEngine = null;
    this.selection = this.initialSelectionValue;
    this.seenTabToOpenCompletionList = false;
    this.lastRequestId = null;
  }

  updateSelection() {
    // For suggestions from custom search engines, we copy the suggestion's text into the input when
    // the suggestion is selected, and revert when it is not. This allows the user to select a
    // suggestion and then continue typing.
    const completion = this.completions[this.selection];
    const shouldReplaceInputWithSuggestion = this.selection >= 0 &&
      completion.insertText != null;
    if (shouldReplaceInputWithSuggestion) {
      if (this.previousInputValue == null) {
        this.previousInputValue = this.input.value;
      }
      this.input.value = completion.insertText;
    } else if (this.previousInputValue != null) {
      this.input.value = this.previousInputValue;
      this.previousInputValue = null;
    }

    // Highlight the selected entry.
    for (const [i, el] of Object.entries(this.completionList.children)) {
      el.className = i == this.selection ? "selected" : "";
    }
  }

  // Returns the user's action ("up", "down", "tab", etc, or null) based on their keypress. We
  // support the arrow keys and various other shortcuts, and this function hides the event-decoding
  // complexity.
  actionFromKeyEvent(event) {
    const key = KeyboardUtils.getKeyChar(event);
    // Handle <Enter> on "keypress", and other events on "keydown". This avoids interence with CJK
    // translation (see #2915 and #2934).
    if ((event.type === "keypress") && (key !== "enter")) return null;
    if ((event.type === "keydown") && (key === "enter")) return null;
    if (KeyboardUtils.isEscape(event)) {
      return "dismiss";
    } else if (
      (key === "up") ||
      (event.shiftKey && (event.key === "Tab")) ||
      (event.ctrlKey && ((key === "k") || (key === "p")))
    ) {
      return "up";
    } else if ((event.key === "Tab") && !event.shiftKey) {
      return "tab";
    } else if (
      (key === "down") ||
      (event.ctrlKey && ((key === "j") || (key === "n")))
    ) {
      return "down";
    } else if (event.ctrlKey && (key === "enter")) {
      return "ctrl-enter";
    } else if (event.key === "Enter") {
      return "enter";
    } else if ((event.key === "Delete") && event.shiftKey && !event.ctrlKey && !event.altKey) {
      return "remove";
    } else if (KeyboardUtils.isBackspace(event)) {
      return "delete";
    }

    return null;
  }

  async onKeyEvent(event) {
    const action = this.actionFromKeyEvent(event);
    if (!action) {
      return;
    }

    if (action === "dismiss") {
      this.hide();
    } else if (["tab", "down"].includes(action)) {
      if (
        (action === "tab") &&
        (this.completerName === "omni") &&
        !this.seenTabToOpenCompletionList &&
        (this.input.value.trim().length === 0)
      ) {
        this.seenTabToOpenCompletionList = true;
        this.update();
      } else if (this.completions.length > 0) {
        this.selection += 1;
        if (this.selection === this.completions.length) {
          this.selection = this.initialSelectionValue;
        }
        this.updateSelection();
      }
    } else if (action === "up") {
      this.selection -= 1;
      if (this.selection < this.initialSelectionValue) {
        this.selection = this.completions.length - 1;
      }
      this.updateSelection();
    } else if (action === "enter") {
      await this.handleEnterKey(event);
    } else if (action === "ctrl-enter") {
      // Populate the vomnibar with the current selection's URL.
      if (!this.isUserSearchEngineActive() && (this.selection >= 0)) {
        if (this.previousInputValue == null) {
          this.previousInputValue = this.input.value;
        }
        this.input.value = this.completions[this.selection]?.url;
        this.input.scrollLeft = this.input.scrollWidth;
      }
    } else if (action === "delete") {
      if (this.isUserSearchEngineActive() && (this.input.selectionEnd === 0)) {
        // Normally, with custom search engines, the keyword (e.g. the "w" of "w query terms") is
        // suppressed. If the cursor is at the start of the input, then reinstate the keyword (the
        // "w").
        const keyword = this.activeUserSearchEngine.keyword;
        this.input.value = keyword + this.input.value.trimStart();
        this.input.selectionStart = this.input.selectionEnd = keyword.length;
        this.activeUserSearchEngine = null;
        this.update();
      } else if (this.seenTabToOpenCompletionList && (this.input.value.trim().length === 0)) {
        this.seenTabToOpenCompletionList = false;
        this.update();
      } else {
        return; // Do not suppress event.
      }
    } else if ((action === "remove") && (this.selection >= 0)) {
      const completion = this.completions[this.selection];
      console.log(completion);
    }

    event.stopImmediatePropagation();
    event.preventDefault();
  }

  async handleEnterKey(event) {
    const isPrimarySearchSuggestion = (c) => c?.isPrimarySuggestion && c?.isCustomSearch;
    let query = this.input.value.trim();

    // Note that it's possible that this.completions is empty. This can happen in practice if the
    // user hits enter quickly after loading the vomnibar, before the filterCompletions request to
    // the background page finishes.
    const waitingOnCompletions = this.completions.length == 0;
    const completion = this.completions[this.selection];

    const openInNewTab = this.forceNewTab || event.shiftKey || event.ctrlKey || event.altKey ||
      event.metaKey;

    // If the user types something and hits enter without selecting a completion from the list,
    // then:
    //   - If they've activated a custom search engine in the Vomnibar, then launch that search
    //     using the typed-in query.
    //   - Otherwise, open the query as a URL or create a default search as appropriate.
    //
    //  When launching a query in a custom search engine, the user may have typed more text than
    //  that which is included in the URL associated with the primary suggestion, because the
    //  suggestions are updated asynchronously. Therefore, to avoid a race condition, we construct
    //  the search URL from the actual contents of the input (query).
    if (waitingOnCompletions || this.selection == -1) {
      // <Enter> on an empty query is a no-op.
      if (query.length == 0) return;
      const firstCompletion = this.completions[0];
      const isPrimary = isPrimarySearchSuggestion(firstCompletion);
      if (isPrimary) {
        query = UrlUtils.createSearchUrl(query, firstCompletion.searchUrl);
        await this.launchUrl(query);
      } else {
        // If the query looks like a URL, try to open it directly. Otherwise, pass the query to
        // the user's default search engine.
        // TODO(philc):
        const isUrl = await UrlUtils.isUrl(query);
        if (isUrl) {
          await this.launchUrl(query, openInNewTab);
        } else {
          this.hide(() =>
            chrome.runtime.sendMessage({
              handler: "launchSearchQuery",
              query,
              openInNewTab,
            })
          );
        }
      }
    } else if (isPrimarySearchSuggestion(completion)) {
      query = UrlUtils.createSearchUrl(query, completion.searchUrl);
      this.hide(() => this.launchUrl(query, openInNewTab));
    } else {
      this.hide(() => this.openCompletion(completion, openInNewTab));
    }
  }

  // Return the background-page query corresponding to the current input state. In other words,
  // reinstate any search engine keyword which is currently being suppressed, and strip any prompted
  // text.
  getInputValueAsQuery() {
    const prefix = this.isUserSearchEngineActive() ? this.activeUserSearchEngine.keyword + " " : "";
    return prefix + this.input.value;
  }

  async updateCompletions() {
    const requestId = Utils.createUniqueId();
    this.lastRequestId = requestId;
    const query = this.getInputValueAsQuery();
    const queryTerms = query.trim().split(/\s+/).filter((s) => s.length > 0);

    const results = await chrome.runtime.sendMessage({
      handler: "filterCompletions",
      completerName: this.completerName,
      queryTerms,
      query,
      seenTabToOpenCompletionList: this.seenTabToOpenCompletionList,
    });

    // Ensure that no new filter requests have gone out while waiting for this result.
    if (this.lastRequestId != requestId) return;

    this.completions = results;
    this.selection = this.completions[0]?.autoSelect ? 0 : this.initialSelectionValue;
    this.renderCompletions(this.completions);
    this.selection = Math.min(
      this.completions.length - 1,
      Math.max(this.initialSelectionValue, this.selection),
    );
    this.updateSelection();
  }

  renderCompletions(completions) {
    this.completionList.innerHTML = completions.map((c) => `<li>${c.html}</li>`).join("");
    this.completionList.style.display = completions.length > 0 ? "block" : "";
  }

  refreshCompletions() {
    chrome.runtime.sendMessage({
      handler: "refreshCompletions",
      completerName: this.completerName,
    });
  }

  cancelCompletions() {
    // Let the background page's completer optionally abandon any pending query, because the user is
    // typing and another query will arrive soon.
    chrome.runtime.sendMessage({
      handler: "cancelCompletions",
      completerName: this.completerName,
    });
  }

  onInput() {
    this.seenTabToOpenCompletionList = false;
    this.cancelCompletions();

    // For custom search engines, we suppress the leading prefix (e.g. the "w" of "w query terms")
    // within the vomnibar input.
    if (!this.isUserSearchEngineActive() && this.getUserSearchEngineForQuery() != null) {
      this.activeUserSearchEngine = this.getUserSearchEngineForQuery();
      const queryTerms = this.input.value.trim().split(/\s+/);
      this.input.value = queryTerms.slice(1).join(" ");
    }

    // If the user types, then don't reset any previous text, and reset the selection.
    if (this.previousInputValue != null) {
      this.previousInputValue = null;
      this.selection = -1;
    }
    this.update();
  }

  // Returns the UserSearchEngine for the given query. Returns null if the query does not begin with
  // a keyword from one of the user's search engines.
  getUserSearchEngineForQuery() {
    // This logic is duplicated from SearchEngineCompleter.getEngineForQueryPrefix
    const parts = this.input.value.trimStart().split(/\s+/);
    // For a keyword "w", we match "w search terms" and "w ", but not "w" on its own.
    const keyword = parts[0];
    if (parts.length <= 1) return null;
    // Don't match queries for built-in properties like "constructor". See #4396.
    if (Object.hasOwn(userSearchEngines.keywordToEngine, keyword)) {
      return userSearchEngines.keywordToEngine[keyword];
    }
    return null;
  }

  async update() {
    await this.updateCompletions();
    this.input.focus();
  }

  openCompletion(completion, openInNewTab) {
    if (completion.description == "tab") {
      chrome.runtime.sendMessage({ handler: "selectSpecificTab", id: completion.tabId });
    } else {
      this.launchUrl(completion.url, openInNewTab);
    }
  }

  async launchUrl(url, openInNewTab) {
    // If the URL is a bookmarklet (so, prefixed with "javascript:"), then always open it in the
    // current tab.
    if (openInNewTab && UrlUtils.hasJavascriptProtocol(url)) {
      openInNewTab = false;
    }
    await chrome.runtime.sendMessage({
      handler: openInNewTab ? "openUrlInNewTab" : "openUrlInCurrentTab",
      url,
    });
  }

  initDom() {
    this.box = document.getElementById("vomnibar");

    this.input = this.box.querySelector("input");
    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("keydown", this.onKeyEvent);
    this.input.addEventListener("keypress", this.onKeyEvent);
    this.completionList = this.box.querySelector("ul");
    this.completionList.style.display = "";

    window.addEventListener("focus", () => this.input.focus());
    // A click in the vomnibar itself refocuses the input.
    this.box.addEventListener("click", (event) => {
      this.input.focus();
      return event.stopImmediatePropagation();
    });
    // A click anywhere else hides the vomnibar.
    document.addEventListener("click", () => this.hide());
  }
}

let vomnibarInstance;

function init() {
  UIComponentMessenger.init();
  UIComponentMessenger.registerHandler(function (event) {
    switch (event.data.name) {
      case "hide":
        ui?.hide();
        break;
      case "hidden":
        ui?.onHidden();
        break;
      case "activate":
        const options = Object.assign({}, event.data);
        delete options.name;
        activate(options);
        break;
      default:
        Utils.assert(false, "Unrecognized message type.", event.data);
    }
  });
}

const testEnv = globalThis.window == null ||
  globalThis.window.location.search.includes("dom_tests=true");
if (!testEnv) {
  document.addEventListener("DOMContentLoaded", async () => {
    await Settings.onLoaded();
    DomUtils.injectUserCss(); // Manually inject custom user styles.
  });
  init();
}
