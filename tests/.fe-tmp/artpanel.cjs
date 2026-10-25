"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js
var require_use_sync_external_store_shim_production = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js"(exports2) {
    "use strict";
    var React = require("react");
    function is(x, y) {
      return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
    }
    var objectIs = "function" === typeof Object.is ? Object.is : is;
    var useState2 = React.useState;
    var useEffect2 = React.useEffect;
    var useLayoutEffect = React.useLayoutEffect;
    var useDebugValue2 = React.useDebugValue;
    function useSyncExternalStore$2(subscribe, getSnapshot) {
      var value = getSnapshot(), _useState = useState2({ inst: { value, getSnapshot } }), inst = _useState[0].inst, forceUpdate = _useState[1];
      useLayoutEffect(
        function() {
          inst.value = value;
          inst.getSnapshot = getSnapshot;
          checkIfSnapshotChanged(inst) && forceUpdate({ inst });
        },
        [subscribe, value, getSnapshot]
      );
      useEffect2(
        function() {
          checkIfSnapshotChanged(inst) && forceUpdate({ inst });
          return subscribe(function() {
            checkIfSnapshotChanged(inst) && forceUpdate({ inst });
          });
        },
        [subscribe]
      );
      useDebugValue2(value);
      return value;
    }
    function checkIfSnapshotChanged(inst) {
      var latestGetSnapshot = inst.getSnapshot;
      inst = inst.value;
      try {
        var nextValue = latestGetSnapshot();
        return !objectIs(inst, nextValue);
      } catch (error) {
        return true;
      }
    }
    function useSyncExternalStore$1(subscribe, getSnapshot) {
      return getSnapshot();
    }
    var shim = "undefined" === typeof window || "undefined" === typeof window.document || "undefined" === typeof window.document.createElement ? useSyncExternalStore$1 : useSyncExternalStore$2;
    exports2.useSyncExternalStore = void 0 !== React.useSyncExternalStore ? React.useSyncExternalStore : shim;
  }
});

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.development.js
var require_use_sync_external_store_shim_development = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.development.js"(exports2) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function is(x, y) {
        return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
      }
      function useSyncExternalStore$2(subscribe, getSnapshot) {
        didWarnOld18Alpha || void 0 === React.startTransition || (didWarnOld18Alpha = true, console.error(
          "You are using an outdated, pre-release alpha of React 18 that does not support useSyncExternalStore. The use-sync-external-store shim will not work correctly. Upgrade to a newer pre-release."
        ));
        var value = getSnapshot();
        if (!didWarnUncachedGetSnapshot) {
          var cachedValue = getSnapshot();
          objectIs(value, cachedValue) || (console.error(
            "The result of getSnapshot should be cached to avoid an infinite loop"
          ), didWarnUncachedGetSnapshot = true);
        }
        cachedValue = useState2({
          inst: { value, getSnapshot }
        });
        var inst = cachedValue[0].inst, forceUpdate = cachedValue[1];
        useLayoutEffect(
          function() {
            inst.value = value;
            inst.getSnapshot = getSnapshot;
            checkIfSnapshotChanged(inst) && forceUpdate({ inst });
          },
          [subscribe, value, getSnapshot]
        );
        useEffect2(
          function() {
            checkIfSnapshotChanged(inst) && forceUpdate({ inst });
            return subscribe(function() {
              checkIfSnapshotChanged(inst) && forceUpdate({ inst });
            });
          },
          [subscribe]
        );
        useDebugValue2(value);
        return value;
      }
      function checkIfSnapshotChanged(inst) {
        var latestGetSnapshot = inst.getSnapshot;
        inst = inst.value;
        try {
          var nextValue = latestGetSnapshot();
          return !objectIs(inst, nextValue);
        } catch (error) {
          return true;
        }
      }
      function useSyncExternalStore$1(subscribe, getSnapshot) {
        return getSnapshot();
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var React = require("react"), objectIs = "function" === typeof Object.is ? Object.is : is, useState2 = React.useState, useEffect2 = React.useEffect, useLayoutEffect = React.useLayoutEffect, useDebugValue2 = React.useDebugValue, didWarnOld18Alpha = false, didWarnUncachedGetSnapshot = false, shim = "undefined" === typeof window || "undefined" === typeof window.document || "undefined" === typeof window.document.createElement ? useSyncExternalStore$1 : useSyncExternalStore$2;
      exports2.useSyncExternalStore = void 0 !== React.useSyncExternalStore ? React.useSyncExternalStore : shim;
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// node_modules/use-sync-external-store/shim/index.js
var require_shim = __commonJS({
  "node_modules/use-sync-external-store/shim/index.js"(exports2, module2) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module2.exports = require_use_sync_external_store_shim_production();
    } else {
      module2.exports = require_use_sync_external_store_shim_development();
    }
  }
});

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js
var require_with_selector_production = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js"(exports2) {
    "use strict";
    var React = require("react");
    var shim = require_shim();
    function is(x, y) {
      return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
    }
    var objectIs = "function" === typeof Object.is ? Object.is : is;
    var useSyncExternalStore = shim.useSyncExternalStore;
    var useRef2 = React.useRef;
    var useEffect2 = React.useEffect;
    var useMemo2 = React.useMemo;
    var useDebugValue2 = React.useDebugValue;
    exports2.useSyncExternalStoreWithSelector = function(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
      var instRef = useRef2(null);
      if (null === instRef.current) {
        var inst = { hasValue: false, value: null };
        instRef.current = inst;
      } else inst = instRef.current;
      instRef = useMemo2(
        function() {
          function memoizedSelector(nextSnapshot) {
            if (!hasMemo) {
              hasMemo = true;
              memoizedSnapshot = nextSnapshot;
              nextSnapshot = selector(nextSnapshot);
              if (void 0 !== isEqual && inst.hasValue) {
                var currentSelection = inst.value;
                if (isEqual(currentSelection, nextSnapshot))
                  return memoizedSelection = currentSelection;
              }
              return memoizedSelection = nextSnapshot;
            }
            currentSelection = memoizedSelection;
            if (objectIs(memoizedSnapshot, nextSnapshot)) return currentSelection;
            var nextSelection = selector(nextSnapshot);
            if (void 0 !== isEqual && isEqual(currentSelection, nextSelection))
              return memoizedSnapshot = nextSnapshot, currentSelection;
            memoizedSnapshot = nextSnapshot;
            return memoizedSelection = nextSelection;
          }
          var hasMemo = false, memoizedSnapshot, memoizedSelection, maybeGetServerSnapshot = void 0 === getServerSnapshot ? null : getServerSnapshot;
          return [
            function() {
              return memoizedSelector(getSnapshot());
            },
            null === maybeGetServerSnapshot ? void 0 : function() {
              return memoizedSelector(maybeGetServerSnapshot());
            }
          ];
        },
        [getSnapshot, getServerSnapshot, selector, isEqual]
      );
      var value = useSyncExternalStore(subscribe, instRef[0], instRef[1]);
      useEffect2(
        function() {
          inst.hasValue = true;
          inst.value = value;
        },
        [value]
      );
      useDebugValue2(value);
      return value;
    };
  }
});

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.development.js
var require_with_selector_development = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.development.js"(exports2) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function is(x, y) {
        return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var React = require("react"), shim = require_shim(), objectIs = "function" === typeof Object.is ? Object.is : is, useSyncExternalStore = shim.useSyncExternalStore, useRef2 = React.useRef, useEffect2 = React.useEffect, useMemo2 = React.useMemo, useDebugValue2 = React.useDebugValue;
      exports2.useSyncExternalStoreWithSelector = function(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
        var instRef = useRef2(null);
        if (null === instRef.current) {
          var inst = { hasValue: false, value: null };
          instRef.current = inst;
        } else inst = instRef.current;
        instRef = useMemo2(
          function() {
            function memoizedSelector(nextSnapshot) {
              if (!hasMemo) {
                hasMemo = true;
                memoizedSnapshot = nextSnapshot;
                nextSnapshot = selector(nextSnapshot);
                if (void 0 !== isEqual && inst.hasValue) {
                  var currentSelection = inst.value;
                  if (isEqual(currentSelection, nextSnapshot))
                    return memoizedSelection = currentSelection;
                }
                return memoizedSelection = nextSnapshot;
              }
              currentSelection = memoizedSelection;
              if (objectIs(memoizedSnapshot, nextSnapshot))
                return currentSelection;
              var nextSelection = selector(nextSnapshot);
              if (void 0 !== isEqual && isEqual(currentSelection, nextSelection))
                return memoizedSnapshot = nextSnapshot, currentSelection;
              memoizedSnapshot = nextSnapshot;
              return memoizedSelection = nextSelection;
            }
            var hasMemo = false, memoizedSnapshot, memoizedSelection, maybeGetServerSnapshot = void 0 === getServerSnapshot ? null : getServerSnapshot;
            return [
              function() {
                return memoizedSelector(getSnapshot());
              },
              null === maybeGetServerSnapshot ? void 0 : function() {
                return memoizedSelector(maybeGetServerSnapshot());
              }
            ];
          },
          [getSnapshot, getServerSnapshot, selector, isEqual]
        );
        var value = useSyncExternalStore(subscribe, instRef[0], instRef[1]);
        useEffect2(
          function() {
            inst.hasValue = true;
            inst.value = value;
          },
          [value]
        );
        useDebugValue2(value);
        return value;
      };
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// node_modules/use-sync-external-store/shim/with-selector.js
var require_with_selector = __commonJS({
  "node_modules/use-sync-external-store/shim/with-selector.js"(exports2, module2) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module2.exports = require_with_selector_production();
    } else {
      module2.exports = require_with_selector_development();
    }
  }
});

// tests/_globals.ts
globalThis.window = {
  addEventListener: () => {
  },
  dispatchEvent: () => {
  },
  localStorage: {
    _d: {},
    getItem(k) {
      return this._d[k] ?? null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    }
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return void 0;
        return async () => ({ ok: true, data: null });
      }
    }
  )
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.openExternal = async () => {
};

// tests/artifactPanel.ssr.test.tsx
var import_server = require("react-dom/server");

// src/components/ArtifactPanel.tsx
var import_react2 = require("react");
var import_react_markdown = __toESM(require("react-markdown"), 1);
var import_remark_gfm = __toESM(require("remark-gfm"), 1);

// node_modules/highlight.js/es/languages/bash.js
function bash(hljs) {
  const regex = hljs.regex;
  const VAR = {};
  const BRACED_VAR = {
    begin: /\$\{/,
    end: /\}/,
    contains: [
      "self",
      {
        begin: /:-/,
        contains: [VAR]
      }
      // default values
    ]
  };
  Object.assign(VAR, {
    className: "variable",
    variants: [
      { begin: regex.concat(
        /\$[\w\d#@][\w\d_]*/,
        // negative look-ahead tries to avoid matching patterns that are not
        // Perl at all like $ident$, @ident@, etc.
        `(?![\\w\\d])(?![$])`
      ) },
      BRACED_VAR
    ]
  });
  const SUBST = {
    className: "subst",
    begin: /\$\(/,
    end: /\)/,
    contains: [hljs.BACKSLASH_ESCAPE]
  };
  const COMMENT = hljs.inherit(
    hljs.COMMENT(),
    {
      match: [
        /(^|\s)/,
        /#.*$/
      ],
      scope: {
        2: "comment"
      }
    }
  );
  const HERE_DOC = {
    begin: /<<-?\s*(?=\w+)/,
    starts: { contains: [
      hljs.END_SAME_AS_BEGIN({
        begin: /(\w+)/,
        end: /(\w+)/,
        className: "string"
      })
    ] }
  };
  const QUOTE_STRING = {
    className: "string",
    begin: /"/,
    end: /"/,
    contains: [
      hljs.BACKSLASH_ESCAPE,
      VAR,
      SUBST
    ]
  };
  SUBST.contains.push(QUOTE_STRING);
  const ESCAPED_QUOTE = {
    match: /\\"/
  };
  const APOS_STRING = {
    className: "string",
    begin: /'/,
    end: /'/
  };
  const ESCAPED_APOS = {
    match: /\\'/
  };
  const ARITHMETIC = {
    begin: /\$?\(\(/,
    end: /\)\)/,
    contains: [
      {
        begin: /\d+#[0-9a-f]+/,
        className: "number"
      },
      hljs.NUMBER_MODE,
      VAR
    ]
  };
  const SH_LIKE_SHELLS = [
    "fish",
    "bash",
    "zsh",
    "sh",
    "csh",
    "ksh",
    "tcsh",
    "dash",
    "scsh"
  ];
  const KNOWN_SHEBANG = hljs.SHEBANG({
    binary: `(${SH_LIKE_SHELLS.join("|")})`,
    relevance: 10
  });
  const FUNCTION = {
    className: "function",
    begin: /\w[\w\d_]*\s*\(\s*\)\s*\{/,
    returnBegin: true,
    contains: [hljs.inherit(hljs.TITLE_MODE, { begin: /\w[\w\d_]*/ })],
    relevance: 0
  };
  const KEYWORDS3 = [
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "time",
    "for",
    "while",
    "until",
    "in",
    "do",
    "done",
    "case",
    "esac",
    "coproc",
    "function",
    "select"
  ];
  const LITERALS3 = [
    "true",
    "false"
  ];
  const PATH_MODE = { match: /(\/[a-z._-]+)+/ };
  const SHELL_BUILT_INS = [
    "break",
    "cd",
    "continue",
    "eval",
    "exec",
    "exit",
    "export",
    "getopts",
    "hash",
    "pwd",
    "readonly",
    "return",
    "shift",
    "test",
    "times",
    "trap",
    "umask",
    "unset"
  ];
  const BASH_BUILT_INS = [
    "alias",
    "bind",
    "builtin",
    "caller",
    "command",
    "declare",
    "echo",
    "enable",
    "help",
    "let",
    "local",
    "logout",
    "mapfile",
    "printf",
    "read",
    "readarray",
    "source",
    "sudo",
    "type",
    "typeset",
    "ulimit",
    "unalias"
  ];
  const ZSH_BUILT_INS = [
    "autoload",
    "bg",
    "bindkey",
    "bye",
    "cap",
    "chdir",
    "clone",
    "comparguments",
    "compcall",
    "compctl",
    "compdescribe",
    "compfiles",
    "compgroups",
    "compquote",
    "comptags",
    "comptry",
    "compvalues",
    "dirs",
    "disable",
    "disown",
    "echotc",
    "echoti",
    "emulate",
    "fc",
    "fg",
    "float",
    "functions",
    "getcap",
    "getln",
    "history",
    "integer",
    "jobs",
    "kill",
    "limit",
    "log",
    "noglob",
    "popd",
    "print",
    "pushd",
    "pushln",
    "rehash",
    "sched",
    "setcap",
    "setopt",
    "stat",
    "suspend",
    "ttyctl",
    "unfunction",
    "unhash",
    "unlimit",
    "unsetopt",
    "vared",
    "wait",
    "whence",
    "where",
    "which",
    "zcompile",
    "zformat",
    "zftp",
    "zle",
    "zmodload",
    "zparseopts",
    "zprof",
    "zpty",
    "zregexparse",
    "zsocket",
    "zstyle",
    "ztcp"
  ];
  const GNU_CORE_UTILS = [
    "chcon",
    "chgrp",
    "chown",
    "chmod",
    "cp",
    "dd",
    "df",
    "dir",
    "dircolors",
    "ln",
    "ls",
    "mkdir",
    "mkfifo",
    "mknod",
    "mktemp",
    "mv",
    "realpath",
    "rm",
    "rmdir",
    "shred",
    "sync",
    "touch",
    "truncate",
    "vdir",
    "b2sum",
    "base32",
    "base64",
    "cat",
    "cksum",
    "comm",
    "csplit",
    "cut",
    "expand",
    "fmt",
    "fold",
    "head",
    "join",
    "md5sum",
    "nl",
    "numfmt",
    "od",
    "paste",
    "ptx",
    "pr",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "shuf",
    "sort",
    "split",
    "sum",
    "tac",
    "tail",
    "tr",
    "tsort",
    "unexpand",
    "uniq",
    "wc",
    "arch",
    "basename",
    "chroot",
    "date",
    "dirname",
    "du",
    "echo",
    "env",
    "expr",
    "factor",
    // "false", // keyword literal already
    "groups",
    "hostid",
    "id",
    "link",
    "logname",
    "nice",
    "nohup",
    "nproc",
    "pathchk",
    "pinky",
    "printenv",
    "printf",
    "pwd",
    "readlink",
    "runcon",
    "seq",
    "sleep",
    "stat",
    "stdbuf",
    "stty",
    "tee",
    "test",
    "timeout",
    // "true", // keyword literal already
    "tty",
    "uname",
    "unlink",
    "uptime",
    "users",
    "who",
    "whoami",
    "yes"
  ];
  return {
    name: "Bash",
    aliases: [
      "sh",
      "zsh"
    ],
    keywords: {
      $pattern: /\b[a-z][a-z0-9._-]+\b/,
      keyword: KEYWORDS3,
      literal: LITERALS3,
      built_in: [
        ...SHELL_BUILT_INS,
        ...BASH_BUILT_INS,
        // Shell modifiers
        "set",
        "shopt",
        ...ZSH_BUILT_INS,
        ...GNU_CORE_UTILS
      ]
    },
    contains: [
      KNOWN_SHEBANG,
      // to catch known shells and boost relevancy
      hljs.SHEBANG(),
      // to catch unknown shells but still highlight the shebang
      FUNCTION,
      ARITHMETIC,
      COMMENT,
      HERE_DOC,
      PATH_MODE,
      QUOTE_STRING,
      ESCAPED_QUOTE,
      APOS_STRING,
      ESCAPED_APOS,
      VAR
    ]
  };
}

// node_modules/highlight.js/es/languages/c.js
function c(hljs) {
  const regex = hljs.regex;
  const C_LINE_COMMENT_MODE = hljs.COMMENT("//", "$", { contains: [{ begin: /\\\n/ }] });
  const DECLTYPE_AUTO_RE = "decltype\\(auto\\)";
  const NAMESPACE_RE = "[a-zA-Z_]\\w*::";
  const TEMPLATE_ARGUMENT_RE = "<[^<>]+>";
  const FUNCTION_TYPE_RE = "(" + DECLTYPE_AUTO_RE + "|" + regex.optional(NAMESPACE_RE) + "[a-zA-Z_]\\w*" + regex.optional(TEMPLATE_ARGUMENT_RE) + ")";
  const ATOMIC_TYPES = regex.concat(/\batomic_/, regex.either(
    "bool",
    "char",
    "schar",
    "uchar",
    "short",
    "ushort",
    "int",
    "uint",
    "long",
    "ulong",
    "llong",
    "ullong",
    "char16_t",
    "char32_t",
    "wchar_t",
    "int_least8_t",
    "uint_least8_t",
    "int_least16_t",
    "uint_least16_t",
    "int_least32_t",
    "uint_least32_t",
    "int_least64_t",
    "uint_least64_t",
    "int_fast8_t",
    "uint_fast8_t",
    "int_fast16_t",
    "uint_fast16_t",
    "int_fast32_t",
    "uint_fast32_t",
    "int_fast64_t",
    "uint_fast64_t",
    "intptr_t",
    "uintptr_t",
    "size_t",
    "ptrdiff_t",
    "intmax_t",
    "uintmax_t"
  ), /\b/);
  const TYPES3 = {
    className: "type",
    variants: [
      { begin: "\\b[a-z\\d_]*_t\\b" },
      { match: ATOMIC_TYPES }
    ]
  };
  const CHARACTER_ESCAPES = "\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)";
  const STRINGS = {
    className: "string",
    variants: [
      {
        begin: '(u8?|U|L)?"',
        end: '"',
        illegal: "\\n",
        contains: [hljs.BACKSLASH_ESCAPE]
      },
      {
        begin: "(u8?|U|L)?'(" + CHARACTER_ESCAPES + "|.)",
        end: "'",
        illegal: "."
      },
      // https://en.cppreference.com/w/cpp/language/string_literal
      // a d-char-sequence never contains parentheses, backslashes or whitespace;
      // quotes are excluded as well so the closing delimiter cannot swallow the
      // quote that actually terminates the literal
      hljs.END_SAME_AS_BEGIN({
        begin: /(?:u8?|U|L)?R"([^()\\\s"]{0,16})\(/,
        end: /\)([^()\\\s"]{0,16})"/
      })
    ]
  };
  const NUMBERS = {
    className: "number",
    variants: [
      { match: /\b(0b[01']+)/ },
      { match: /(-?)\b([\d']+(\.[\d']*)?|\.[\d']+)((ll|LL|l|L)(u|U)?|(u|U)(ll|LL|l|L)?|f|F|b|B)/ },
      { match: /(-?)\b(0[xX][a-fA-F0-9]+(?:'[a-fA-F0-9]+)*(?:\.[a-fA-F0-9]*(?:'[a-fA-F0-9]*)*)?(?:[pP][-+]?[0-9]+)?(l|L)?(u|U)?)/ },
      { match: /(-?)\b\d+(?:'\d+)*(?:\.\d*(?:'\d*)*)?(?:[eE][-+]?\d+)?/ }
    ],
    relevance: 0
  };
  const PREPROCESSOR_INCLUDE = {
    scope: "meta",
    begin: /#\s*include\b/,
    end: /$/,
    keywords: { keyword: "include" },
    contains: [
      {
        // the `\` at the end of a line signaling continuation
        begin: /\\\n/
      },
      STRINGS,
      {
        scope: "string",
        begin: /<.*?>/
      },
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ]
  };
  const PREPROCESSOR = {
    className: "meta",
    begin: /#\s*[a-z]+\b/,
    end: /$/,
    keywords: { keyword: "if else elif endif define undef warning error line pragma _Pragma ifdef ifndef elifdef elifndef include" },
    contains: [
      {
        begin: /\\\n/,
        relevance: 0
      },
      hljs.inherit(STRINGS, { className: "string" }),
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ]
  };
  const PREPROCESSORS = [
    PREPROCESSOR_INCLUDE,
    PREPROCESSOR
  ];
  const TITLE_MODE = {
    className: "title",
    begin: regex.optional(NAMESPACE_RE) + hljs.IDENT_RE,
    relevance: 0
  };
  const FUNCTION_TITLE = regex.optional(NAMESPACE_RE) + hljs.IDENT_RE + "\\s*\\(";
  const MAX_FUNCTION_TYPE_TOKENS = 12;
  const C_KEYWORDS = [
    "asm",
    "auto",
    "break",
    "case",
    "continue",
    "default",
    "do",
    "else",
    "enum",
    "extern",
    "for",
    "fortran",
    "goto",
    "if",
    "inline",
    "register",
    "restrict",
    "return",
    "sizeof",
    "typeof",
    "typeof_unqual",
    "struct",
    "switch",
    "typedef",
    "union",
    "volatile",
    "while",
    "_Alignas",
    "_Alignof",
    "_Atomic",
    "_Generic",
    "_Noreturn",
    "_Static_assert",
    "_Thread_local",
    // aliases
    "alignas",
    "alignof",
    "noreturn",
    "static_assert",
    "thread_local",
    // not a C keyword but is, for all intents and purposes, treated exactly like one.
    "_Pragma"
  ];
  const C_TYPES = [
    "float",
    "double",
    "signed",
    "unsigned",
    "int",
    "short",
    "long",
    "char",
    "void",
    "_Bool",
    "_BitInt",
    "_Complex",
    "_Imaginary",
    "_Decimal32",
    "_Decimal64",
    "_Decimal96",
    "_Decimal128",
    "_Decimal64x",
    "_Decimal128x",
    "_Float16",
    "_Float32",
    "_Float64",
    "_Float128",
    "_Float32x",
    "_Float64x",
    "_Float128x",
    // modifiers
    "const",
    "static",
    "constexpr",
    // aliases
    "complex",
    "bool",
    "imaginary"
  ];
  const KEYWORDS3 = {
    keyword: C_KEYWORDS,
    type: C_TYPES,
    literal: "true false NULL",
    // TODO: apply hinting work similar to what was done in cpp.js
    built_in: "std string wstring cin cout cerr clog stdin stdout stderr stringstream istringstream ostringstream auto_ptr deque list queue stack vector map set pair bitset multiset multimap unordered_set unordered_map unordered_multiset unordered_multimap priority_queue make_pair array shared_ptr abort terminate abs acos asin atan2 atan calloc ceil cosh cos exit exp fabs floor fmod fprintf fputs free frexp fscanf future isalnum isalpha iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper labs ldexp log10 log malloc realloc memchr memcmp memcpy memset modf pow printf putchar puts scanf sinh sin snprintf sprintf sqrt sscanf strcat strchr strcmp strcpy strcspn strlen strncat strncmp strncpy strpbrk strrchr strspn strstr tanh tan vfprintf vprintf vsprintf endl initializer_list unique_ptr"
  };
  const EXPRESSION_CONTAINS = [
    ...PREPROCESSORS,
    TYPES3,
    C_LINE_COMMENT_MODE,
    hljs.C_BLOCK_COMMENT_MODE,
    NUMBERS,
    STRINGS
  ];
  const EXPRESSION_CONTEXT = {
    // This mode covers expression context where we can't expect a function
    // definition and shouldn't highlight anything that looks like one:
    // `return some()`, `else if()`, `(x*sum(1, 2))`
    variants: [
      {
        begin: /=/,
        end: /;/
      },
      {
        begin: /\(/,
        end: /\)/
      },
      {
        beginKeywords: "new throw return else",
        end: /;/
      }
    ],
    keywords: KEYWORDS3,
    contains: EXPRESSION_CONTAINS.concat([
      {
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS3,
        contains: EXPRESSION_CONTAINS.concat(["self"]),
        relevance: 0
      }
    ]),
    relevance: 0
  };
  const FUNCTION_DECLARATION = {
    begin: "(" + FUNCTION_TYPE_RE + "[\\*&\\s]+){1," + MAX_FUNCTION_TYPE_TOKENS + "}" + FUNCTION_TITLE,
    returnBegin: true,
    end: /[{;=]/,
    excludeEnd: true,
    keywords: KEYWORDS3,
    illegal: /[^\w\s\*&:<>.]/,
    contains: [
      {
        // to prevent it from being confused as the function title
        begin: DECLTYPE_AUTO_RE,
        keywords: KEYWORDS3,
        relevance: 0
      },
      {
        begin: FUNCTION_TITLE,
        returnBegin: true,
        contains: [hljs.inherit(TITLE_MODE, { className: "title.function" })],
        relevance: 0
      },
      // allow for multiple declarations, e.g.:
      // extern void f(int), g(char);
      {
        relevance: 0,
        match: /,/
      },
      {
        className: "params",
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS3,
        relevance: 0,
        contains: [
          C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          STRINGS,
          NUMBERS,
          TYPES3,
          // Count matching parentheses.
          {
            begin: /\(/,
            end: /\)/,
            keywords: KEYWORDS3,
            relevance: 0,
            contains: [
              "self",
              C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE,
              STRINGS,
              NUMBERS,
              TYPES3
            ]
          }
        ]
      },
      TYPES3,
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      ...PREPROCESSORS
    ]
  };
  return {
    name: "C",
    aliases: ["h"],
    keywords: KEYWORDS3,
    // Until differentiations are added between `c` and `cpp`, `c` will
    // not be auto-detected to avoid auto-detect conflicts between C and C++
    disableAutodetect: true,
    illegal: "</",
    contains: [].concat(
      EXPRESSION_CONTEXT,
      FUNCTION_DECLARATION,
      EXPRESSION_CONTAINS,
      [
        ...PREPROCESSORS,
        {
          begin: hljs.IDENT_RE + "::",
          keywords: KEYWORDS3
        },
        {
          className: "class",
          beginKeywords: "enum class struct union",
          end: /[{;:<>=]/,
          contains: [
            { beginKeywords: "final class struct" },
            hljs.TITLE_MODE
          ]
        }
      ]
    ),
    exports: {
      preprocessor: PREPROCESSOR,
      strings: STRINGS,
      keywords: KEYWORDS3
    }
  };
}

// node_modules/highlight.js/es/languages/cpp.js
function cpp(hljs) {
  const regex = hljs.regex;
  const C_LINE_COMMENT_MODE = hljs.COMMENT("//", "$", { contains: [{ begin: /\\\n/ }] });
  const DECLTYPE_AUTO_RE = "decltype\\(auto\\)";
  const NAMESPACE_RE = "[a-zA-Z_]\\w*::";
  const TEMPLATE_ARGUMENT_RE = "<[^<>]+>";
  const FUNCTION_TYPE_RE = "(?!struct)(" + DECLTYPE_AUTO_RE + "|" + regex.optional(NAMESPACE_RE) + "[a-zA-Z_]\\w*" + regex.optional(TEMPLATE_ARGUMENT_RE) + ")";
  const CPP_PRIMITIVE_TYPES = {
    className: "type",
    begin: "\\b[a-z\\d_]*_t\\b"
  };
  const CHARACTER_ESCAPES = "\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)";
  const STRINGS = {
    className: "string",
    variants: [
      {
        begin: '(u8?|U|L)?"',
        end: '"',
        illegal: "\\n",
        contains: [hljs.BACKSLASH_ESCAPE]
      },
      {
        begin: "(u8?|U|L)?'(" + CHARACTER_ESCAPES + "|.)",
        end: "'",
        illegal: "."
      },
      // https://en.cppreference.com/w/cpp/language/string_literal
      // a d-char-sequence never contains parentheses, backslashes or whitespace;
      // quotes are excluded as well so the closing delimiter cannot swallow the
      // quote that actually terminates the literal
      hljs.END_SAME_AS_BEGIN({
        begin: /(?:u8?|U|L)?R"([^()\\\s"]{0,16})\(/,
        end: /\)([^()\\\s"]{0,16})"/
      })
    ]
  };
  const NUMBERS = {
    className: "number",
    variants: [
      // Floating-point literal.
      {
        begin: "[+-]?(?:(?:\\b[0-9](?:'?[0-9])*\\.(?:[0-9](?:'?[0-9])*)?|\\.[0-9](?:'?[0-9])*)(?:[Ee][+-]?[0-9](?:'?[0-9])*)?|\\b[0-9](?:'?[0-9])*[Ee][+-]?[0-9](?:'?[0-9])*|\\b0[Xx](?:[0-9A-Fa-f](?:'?[0-9A-Fa-f])*(?:\\.(?:[0-9A-Fa-f](?:'?[0-9A-Fa-f])*)?)?|\\.[0-9A-Fa-f](?:'?[0-9A-Fa-f])*)[Pp][+-]?[0-9](?:'?[0-9])*)(?:[Ff](?:16|32|64|128)?|(BF|bf)16|[Ll]|)"
      },
      // Integer literal.
      {
        begin: "[+-]?\\b(?:0[Bb][01](?:'?[01])*|0[Xx][0-9A-Fa-f](?:'?[0-9A-Fa-f])*|0(?:'?[0-7])*|[1-9](?:'?[0-9])*)(?:[Uu](?:LL?|ll?)|[Uu][Zz]?|(?:LL?|ll?)[Uu]?|[Zz][Uu]|)"
        // Note: there are user-defined literal suffixes too, but perhaps having the custom suffix not part of the
        // literal highlight actually makes it stand out more.
      }
    ],
    relevance: 0
  };
  const PREPROCESSOR_INCLUDE = {
    scope: "meta",
    begin: /#\s*include\b/,
    end: /$/,
    keywords: { keyword: "include" },
    contains: [
      {
        // the `\` at the end of a line signaling continuation
        begin: /\\\n/
      },
      STRINGS,
      {
        scope: "string",
        begin: /<.*?>/
      },
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ]
  };
  const PREPROCESSOR = {
    className: "meta",
    begin: /#\s*[a-z]+\b/,
    end: /$/,
    keywords: { keyword: "if else elif endif define undef warning error line pragma _Pragma ifdef ifndef include" },
    contains: [
      {
        begin: /\\\n/,
        relevance: 0
      },
      hljs.inherit(STRINGS, { className: "string" }),
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ]
  };
  const PREPROCESSORS = [
    PREPROCESSOR_INCLUDE,
    PREPROCESSOR
  ];
  const TITLE_MODE = {
    className: "title",
    begin: regex.optional(NAMESPACE_RE) + hljs.IDENT_RE,
    relevance: 0
  };
  const FUNCTION_TITLE = regex.optional(NAMESPACE_RE) + hljs.IDENT_RE + "\\s*\\(";
  const MAX_FUNCTION_TYPE_TOKENS = 12;
  const RESERVED_KEYWORDS = [
    "alignas",
    "alignof",
    "and",
    "and_eq",
    "asm",
    "atomic_cancel",
    "atomic_commit",
    "atomic_noexcept",
    "auto",
    "bitand",
    "bitor",
    "break",
    "case",
    "catch",
    "class",
    "co_await",
    "co_return",
    "co_yield",
    "compl",
    "concept",
    "const_cast|10",
    "consteval",
    "constexpr",
    "constinit",
    "continue",
    "decltype",
    "default",
    "delete",
    "do",
    "dynamic_cast|10",
    "else",
    "enum",
    "explicit",
    "export",
    "extern",
    "false",
    "final",
    "for",
    "friend",
    "goto",
    "if",
    "import",
    "inline",
    "module",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "not",
    "not_eq",
    "nullptr",
    "operator",
    "or",
    "or_eq",
    "override",
    "private",
    "protected",
    "public",
    "reflexpr",
    "register",
    "reinterpret_cast|10",
    "requires",
    "return",
    "sizeof",
    "static_assert",
    "static_cast|10",
    "struct",
    "switch",
    "synchronized",
    "template",
    "this",
    "thread_local",
    "throw",
    "transaction_safe",
    "transaction_safe_dynamic",
    "true",
    "try",
    "typedef",
    "typeid",
    "typename",
    "union",
    "using",
    "virtual",
    "volatile",
    "while",
    "xor",
    "xor_eq"
  ];
  const RESERVED_TYPES = [
    "bool",
    "char",
    "char16_t",
    "char32_t",
    "char8_t",
    "double",
    "float",
    "int",
    "long",
    "short",
    "void",
    "wchar_t",
    "unsigned",
    "signed",
    "const",
    "static"
  ];
  const TYPE_HINTS = [
    "any",
    "auto_ptr",
    "barrier",
    "binary_semaphore",
    "bitset",
    "complex",
    "condition_variable",
    "condition_variable_any",
    "counting_semaphore",
    "deque",
    "false_type",
    "flat_map",
    "flat_set",
    "future",
    "imaginary",
    "initializer_list",
    "istringstream",
    "jthread",
    "latch",
    "lock_guard",
    "multimap",
    "multiset",
    "mutex",
    "optional",
    "ostringstream",
    "packaged_task",
    "pair",
    "promise",
    "priority_queue",
    "queue",
    "recursive_mutex",
    "recursive_timed_mutex",
    "scoped_lock",
    "set",
    "shared_future",
    "shared_lock",
    "shared_mutex",
    "shared_timed_mutex",
    "shared_ptr",
    "stack",
    "string_view",
    "stringstream",
    "timed_mutex",
    "thread",
    "true_type",
    "tuple",
    "unique_lock",
    "unique_ptr",
    "unordered_map",
    "unordered_multimap",
    "unordered_multiset",
    "unordered_set",
    "variant",
    "vector",
    "weak_ptr",
    "wstring",
    "wstring_view"
  ];
  const FUNCTION_HINTS = [
    "abort",
    "abs",
    "acos",
    "apply",
    "as_const",
    "asin",
    "atan",
    "atan2",
    "calloc",
    "ceil",
    "cerr",
    "cin",
    "clog",
    "cos",
    "cosh",
    "cout",
    "declval",
    "endl",
    "exchange",
    "exit",
    "exp",
    "fabs",
    "floor",
    "fmod",
    "forward",
    "fprintf",
    "fputs",
    "free",
    "frexp",
    "fscanf",
    "future",
    "invoke",
    "isalnum",
    "isalpha",
    "iscntrl",
    "isdigit",
    "isgraph",
    "islower",
    "isprint",
    "ispunct",
    "isspace",
    "isupper",
    "isxdigit",
    "labs",
    "launder",
    "ldexp",
    "log",
    "log10",
    "make_pair",
    "make_shared",
    "make_shared_for_overwrite",
    "make_tuple",
    "make_unique",
    "malloc",
    "memchr",
    "memcmp",
    "memcpy",
    "memset",
    "modf",
    "move",
    "pow",
    "printf",
    "putchar",
    "puts",
    "realloc",
    "scanf",
    "sin",
    "sinh",
    "snprintf",
    "sprintf",
    "sqrt",
    "sscanf",
    "std",
    "stderr",
    "stdin",
    "stdout",
    "strcat",
    "strchr",
    "strcmp",
    "strcpy",
    "strcspn",
    "strlen",
    "strncat",
    "strncmp",
    "strncpy",
    "strpbrk",
    "strrchr",
    "strspn",
    "strstr",
    "swap",
    "tan",
    "tanh",
    "terminate",
    "to_underlying",
    "tolower",
    "toupper",
    "vfprintf",
    "visit",
    "vprintf",
    "vsprintf"
  ];
  const LITERALS3 = [
    "NULL",
    "false",
    "nullopt",
    "nullptr",
    "true"
  ];
  const BUILT_IN = ["_Pragma"];
  const CPP_KEYWORDS = {
    type: RESERVED_TYPES,
    keyword: RESERVED_KEYWORDS,
    literal: LITERALS3,
    built_in: BUILT_IN,
    _type_hints: TYPE_HINTS
  };
  const FUNCTION_DISPATCH = {
    className: "function.dispatch",
    relevance: 0,
    keywords: {
      // Only for relevance, not highlighting.
      _hint: FUNCTION_HINTS
    },
    begin: regex.concat(
      /\b/,
      `(?!${RESERVED_KEYWORDS.join("|")})`,
      hljs.IDENT_RE,
      regex.lookahead(/(<[^<>]+>|)\s*\(/)
    )
  };
  const EXPRESSION_CONTAINS = [
    FUNCTION_DISPATCH,
    ...PREPROCESSORS,
    CPP_PRIMITIVE_TYPES,
    C_LINE_COMMENT_MODE,
    hljs.C_BLOCK_COMMENT_MODE,
    NUMBERS,
    STRINGS
  ];
  const EXPRESSION_CONTEXT = {
    // This mode covers expression context where we can't expect a function
    // definition and shouldn't highlight anything that looks like one:
    // `return some()`, `else if()`, `(x*sum(1, 2))`
    variants: [
      {
        begin: /=/,
        end: /;/
      },
      {
        begin: /\(/,
        end: /\)/
      },
      {
        beginKeywords: "new throw return else",
        end: /;/
      }
    ],
    keywords: CPP_KEYWORDS,
    contains: EXPRESSION_CONTAINS.concat([
      {
        begin: /\(/,
        end: /\)/,
        keywords: CPP_KEYWORDS,
        contains: EXPRESSION_CONTAINS.concat(["self"]),
        relevance: 0
      }
    ]),
    relevance: 0
  };
  const FUNCTION_DECLARATION = {
    className: "function",
    begin: "(" + FUNCTION_TYPE_RE + "[\\*&\\s]+){1," + MAX_FUNCTION_TYPE_TOKENS + "}" + FUNCTION_TITLE,
    returnBegin: true,
    end: /[{;=]/,
    excludeEnd: true,
    keywords: CPP_KEYWORDS,
    illegal: /[^\w\s\*&:<>.]/,
    contains: [
      {
        // to prevent it from being confused as the function title
        begin: DECLTYPE_AUTO_RE,
        keywords: CPP_KEYWORDS,
        relevance: 0
      },
      {
        begin: FUNCTION_TITLE,
        returnBegin: true,
        contains: [TITLE_MODE],
        relevance: 0
      },
      // needed because we do not have look-behind on the below rule
      // to prevent it from grabbing the final : in a :: pair
      {
        begin: /::/,
        relevance: 0
      },
      // initializers
      {
        begin: /:/,
        endsWithParent: true,
        contains: [
          STRINGS,
          NUMBERS
        ]
      },
      // allow for multiple declarations, e.g.:
      // extern void f(int), g(char);
      {
        relevance: 0,
        match: /,/
      },
      {
        className: "params",
        begin: /\(/,
        end: /\)/,
        keywords: CPP_KEYWORDS,
        relevance: 0,
        contains: [
          C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE,
          STRINGS,
          NUMBERS,
          CPP_PRIMITIVE_TYPES,
          // Count matching parentheses.
          {
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            relevance: 0,
            contains: [
              "self",
              C_LINE_COMMENT_MODE,
              hljs.C_BLOCK_COMMENT_MODE,
              STRINGS,
              NUMBERS,
              CPP_PRIMITIVE_TYPES
            ]
          }
        ]
      },
      CPP_PRIMITIVE_TYPES,
      C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      ...PREPROCESSORS
    ]
  };
  return {
    name: "C++",
    aliases: [
      "cc",
      "c++",
      "h++",
      "hpp",
      "hh",
      "hxx",
      "cxx"
    ],
    keywords: CPP_KEYWORDS,
    illegal: "</",
    classNameAliases: { "function.dispatch": "built_in" },
    contains: [].concat(
      EXPRESSION_CONTEXT,
      FUNCTION_DECLARATION,
      FUNCTION_DISPATCH,
      EXPRESSION_CONTAINS,
      [
        ...PREPROCESSORS,
        {
          // containers: ie, `vector <int> rooms (9);`
          begin: "\\b(deque|list|queue|priority_queue|pair|stack|vector|map|set|bitset|multiset|multimap|unordered_map|unordered_set|unordered_multiset|unordered_multimap|array|tuple|optional|variant|function|flat_map|flat_set)\\s*<(?!<)",
          end: ">",
          keywords: CPP_KEYWORDS,
          contains: [
            "self",
            CPP_PRIMITIVE_TYPES
          ]
        },
        {
          begin: hljs.IDENT_RE + "::",
          keywords: CPP_KEYWORDS
        },
        {
          match: [
            // extra complexity to deal with `enum class` and `enum struct`
            /\b(?:enum(?:\s+(?:class|struct))?|class|struct|union)/,
            /\s+/,
            /\w+/
          ],
          className: {
            1: "keyword",
            3: "title.class"
          }
        }
      ]
    )
  };
}

// node_modules/highlight.js/es/languages/csharp.js
function csharp(hljs) {
  const BUILT_IN_KEYWORDS = [
    "bool",
    "byte",
    "char",
    "decimal",
    "delegate",
    "double",
    "dynamic",
    "enum",
    "float",
    "int",
    "long",
    "nint",
    "nuint",
    "object",
    "sbyte",
    "short",
    "string",
    "ulong",
    "uint",
    "ushort"
  ];
  const FUNCTION_MODIFIERS = [
    "public",
    "private",
    "protected",
    "static",
    "internal",
    "protected",
    "abstract",
    "async",
    "extern",
    "override",
    "unsafe",
    "virtual",
    "new",
    "sealed",
    "partial"
  ];
  const LITERAL_KEYWORDS = [
    "default",
    "false",
    "null",
    "true"
  ];
  const NORMAL_KEYWORDS = [
    "abstract",
    "as",
    "base",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "do",
    "else",
    "event",
    "explicit",
    "extern",
    "finally",
    "fixed",
    "for",
    "foreach",
    "goto",
    "if",
    "implicit",
    "in",
    "interface",
    "internal",
    "is",
    "lock",
    "namespace",
    "new",
    "operator",
    "out",
    "override",
    "params",
    "private",
    "protected",
    "public",
    "readonly",
    "record",
    "ref",
    "return",
    "scoped",
    "sealed",
    "sizeof",
    "stackalloc",
    "static",
    "struct",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "unchecked",
    "unsafe",
    "using",
    "virtual",
    "void",
    "volatile",
    "while"
  ];
  const CONTEXTUAL_KEYWORDS = [
    "add",
    "alias",
    "and",
    "ascending",
    "args",
    "async",
    "await",
    "by",
    "descending",
    "dynamic",
    "equals",
    "file",
    "from",
    "get",
    "global",
    "group",
    "init",
    "into",
    "join",
    "let",
    "nameof",
    "not",
    "notnull",
    "on",
    "or",
    "orderby",
    "partial",
    "record",
    "remove",
    "required",
    "scoped",
    "select",
    "set",
    "unmanaged",
    "value|0",
    "var",
    "when",
    "where",
    "with",
    "yield"
  ];
  const KEYWORDS3 = {
    keyword: NORMAL_KEYWORDS.concat(CONTEXTUAL_KEYWORDS),
    built_in: BUILT_IN_KEYWORDS,
    literal: LITERAL_KEYWORDS
  };
  const TITLE_MODE = hljs.inherit(hljs.TITLE_MODE, { begin: "[a-zA-Z](\\.?\\w)*" });
  const DIGITS = "\\d(_*\\d)*";
  const INTEGER_SUFFIX = "([uU][lL]?|[lL][uU]?)?";
  const REAL_SUFFIX = "([fFdDmM]|[uU][lL]?|[lL][uU]?)?";
  const NUMBERS = {
    className: "number",
    variants: [
      { begin: "\\b0[bB]_*[01](_*[01])*" + INTEGER_SUFFIX },
      { begin: "(-?)\\b0[xX]_*[a-fA-F0-9](_*[a-fA-F0-9])*" + INTEGER_SUFFIX },
      { begin: "(-?)(\\b" + DIGITS + "(\\.(" + DIGITS + ")?)?|\\." + DIGITS + ")([eE][-+]?" + DIGITS + ")?" + REAL_SUFFIX }
    ],
    relevance: 0
  };
  const RAW_STRING = {
    className: "string",
    begin: /"""("*)(?!")(.|\n)*?"""\1/,
    relevance: 1
  };
  const VERBATIM_STRING = {
    className: "string",
    begin: '@"',
    end: '"',
    contains: [{ begin: '""' }]
  };
  const VERBATIM_STRING_NO_LF = hljs.inherit(VERBATIM_STRING, { illegal: /\n/ });
  const SUBST = {
    className: "subst",
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS3
  };
  const SUBST_NO_LF = hljs.inherit(SUBST, { illegal: /\n/ });
  const INTERPOLATED_STRING = {
    className: "string",
    begin: /\$"/,
    end: '"',
    illegal: /\n/,
    contains: [
      { begin: /\{\{/ },
      { begin: /\}\}/ },
      hljs.BACKSLASH_ESCAPE,
      SUBST_NO_LF
    ]
  };
  const INTERPOLATED_VERBATIM_STRING = {
    className: "string",
    begin: /\$@"/,
    end: '"',
    contains: [
      { begin: /\{\{/ },
      { begin: /\}\}/ },
      { begin: '""' },
      SUBST
    ]
  };
  const INTERPOLATED_VERBATIM_STRING_NO_LF = hljs.inherit(INTERPOLATED_VERBATIM_STRING, {
    illegal: /\n/,
    contains: [
      { begin: /\{\{/ },
      { begin: /\}\}/ },
      { begin: '""' },
      SUBST_NO_LF
    ]
  });
  SUBST.contains = [
    INTERPOLATED_VERBATIM_STRING,
    INTERPOLATED_STRING,
    VERBATIM_STRING,
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE,
    NUMBERS,
    hljs.C_BLOCK_COMMENT_MODE
  ];
  SUBST_NO_LF.contains = [
    INTERPOLATED_VERBATIM_STRING_NO_LF,
    INTERPOLATED_STRING,
    VERBATIM_STRING_NO_LF,
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE,
    NUMBERS,
    hljs.inherit(hljs.C_BLOCK_COMMENT_MODE, { illegal: /\n/ })
  ];
  const STRING = { variants: [
    RAW_STRING,
    INTERPOLATED_VERBATIM_STRING,
    INTERPOLATED_STRING,
    VERBATIM_STRING,
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE
  ] };
  const GENERIC_MODIFIER = {
    begin: "<",
    end: ">",
    contains: [
      { beginKeywords: "in out" },
      TITLE_MODE
    ]
  };
  const TYPE_IDENT_RE = hljs.IDENT_RE + "(<" + hljs.IDENT_RE + "(\\s*,\\s*" + hljs.IDENT_RE + ")*>)?(\\[\\])?";
  const AT_IDENTIFIER = {
    // prevents expressions like `@class` from incorrect flagging
    // `class` as a keyword
    begin: "@" + hljs.IDENT_RE,
    relevance: 0
  };
  return {
    name: "C#",
    aliases: [
      "cs",
      "c#"
    ],
    keywords: KEYWORDS3,
    illegal: /::/,
    contains: [
      hljs.COMMENT(
        "///",
        "$",
        {
          returnBegin: true,
          contains: [
            {
              className: "doctag",
              variants: [
                {
                  begin: "///",
                  relevance: 0
                },
                { begin: "<!--|-->" },
                {
                  begin: "</?",
                  end: ">"
                }
              ]
            }
          ]
        }
      ),
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      {
        className: "meta",
        begin: "#",
        end: "$",
        keywords: { keyword: "if else elif endif define undef warning error line region endregion pragma checksum" }
      },
      STRING,
      NUMBERS,
      {
        beginKeywords: "class interface",
        relevance: 0,
        end: /[{;=]/,
        illegal: /[^\s:,]/,
        contains: [
          { beginKeywords: "where class" },
          TITLE_MODE,
          GENERIC_MODIFIER,
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      {
        beginKeywords: "namespace",
        relevance: 0,
        end: /[{;=]/,
        illegal: /[^\s:]/,
        contains: [
          TITLE_MODE,
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      {
        beginKeywords: "record",
        relevance: 0,
        end: /[{;=]/,
        illegal: /[^\s:]/,
        contains: [
          TITLE_MODE,
          GENERIC_MODIFIER,
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      {
        // [Attributes("")]
        className: "meta",
        begin: "^\\s*\\[(?=[\\w])",
        excludeBegin: true,
        end: "\\]",
        excludeEnd: true,
        contains: [
          {
            className: "string",
            begin: /"/,
            end: /"/
          }
        ]
      },
      {
        // Expression keywords prevent 'keyword Name(...)' from being
        // recognized as a function definition
        beginKeywords: "new return throw await else",
        relevance: 0
      },
      {
        className: "function",
        begin: "(" + TYPE_IDENT_RE + "\\s+)+" + hljs.IDENT_RE + "\\s*(<[^=]+>\\s*)?\\(",
        returnBegin: true,
        end: /\s*[{;=]/,
        excludeEnd: true,
        keywords: KEYWORDS3,
        contains: [
          // prevents these from being highlighted `title`
          {
            beginKeywords: FUNCTION_MODIFIERS.join(" "),
            relevance: 0
          },
          {
            begin: hljs.IDENT_RE + "\\s*(<[^=]+>\\s*)?\\(",
            returnBegin: true,
            contains: [
              hljs.TITLE_MODE,
              GENERIC_MODIFIER
            ],
            relevance: 0
          },
          { match: /\(\)/ },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            excludeBegin: true,
            excludeEnd: true,
            keywords: KEYWORDS3,
            relevance: 0,
            contains: [
              STRING,
              NUMBERS,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      AT_IDENTIFIER
    ]
  };
}

// node_modules/highlight.js/es/languages/css.js
var MODES = (hljs) => {
  return {
    IMPORTANT: {
      scope: "meta",
      begin: "!important"
    },
    BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
    HEXCOLOR: {
      scope: "number",
      begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
    },
    UNICODE_RANGE: {
      scope: "number",
      begin: /\b[Uu]\+[0-9A-Fa-f][0-9A-Fa-f?]{0,5}(-[0-9A-Fa-f][0-9A-Fa-f]{0,5})?/
    },
    FUNCTION_DISPATCH: {
      className: "built_in",
      begin: /[\w-]+(?=\()/
    },
    ATTRIBUTE_SELECTOR_MODE: {
      scope: "selector-attr",
      begin: /\[/,
      end: /\]/,
      illegal: "$",
      contains: [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ]
    },
    CSS_NUMBER_MODE: {
      scope: "number",
      begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
      relevance: 0
    },
    CSS_VARIABLE: {
      className: "attr",
      begin: /--[A-Za-z_][A-Za-z0-9_-]*/
    }
  };
};
var HTML_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
  "body",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "object",
  "ol",
  "optgroup",
  "option",
  "p",
  "picture",
  "q",
  "quote",
  "samp",
  "section",
  "select",
  "source",
  "span",
  "strong",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
  "var",
  "video"
];
var SVG_TAGS = [
  "defs",
  "g",
  "marker",
  "mask",
  "pattern",
  "svg",
  "switch",
  "symbol",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feFlood",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feTile",
  "feTurbulence",
  "linearGradient",
  "radialGradient",
  "stop",
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
  "textPath",
  "tspan",
  "foreignObject",
  "clipPath"
];
var TAGS = [
  ...HTML_TAGS,
  ...SVG_TAGS
];
var MEDIA_FEATURES = [
  "any-hover",
  "any-pointer",
  "aspect-ratio",
  "color",
  "color-gamut",
  "color-index",
  "device-aspect-ratio",
  "device-height",
  "device-width",
  "display-mode",
  "forced-colors",
  "grid",
  "height",
  "hover",
  "inverted-colors",
  "monochrome",
  "orientation",
  "overflow-block",
  "overflow-inline",
  "pointer",
  "prefers-color-scheme",
  "prefers-contrast",
  "prefers-reduced-motion",
  "prefers-reduced-transparency",
  "resolution",
  "scan",
  "scripting",
  "update",
  "width",
  // TODO: find a better solution?
  "min-width",
  "max-width",
  "min-height",
  "max-height"
].sort().reverse();
var PSEUDO_CLASSES = [
  "active",
  "any-link",
  "blank",
  "checked",
  "current",
  "default",
  "defined",
  "dir",
  // dir()
  "disabled",
  "drop",
  "empty",
  "enabled",
  "first",
  "first-child",
  "first-of-type",
  "fullscreen",
  "future",
  "focus",
  "focus-visible",
  "focus-within",
  "has",
  // has()
  "host",
  // host or host()
  "host-context",
  // host-context()
  "hover",
  "indeterminate",
  "in-range",
  "invalid",
  "is",
  // is()
  "lang",
  // lang()
  "last-child",
  "last-of-type",
  "left",
  "link",
  "local-link",
  "not",
  // not()
  "nth-child",
  // nth-child()
  "nth-col",
  // nth-col()
  "nth-last-child",
  // nth-last-child()
  "nth-last-col",
  // nth-last-col()
  "nth-last-of-type",
  //nth-last-of-type()
  "nth-of-type",
  //nth-of-type()
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "past",
  "placeholder-shown",
  "read-only",
  "read-write",
  "required",
  "right",
  "root",
  "scope",
  "target",
  "target-within",
  "user-invalid",
  "valid",
  "visited",
  "where"
  // where()
].sort().reverse();
var PSEUDO_ELEMENTS = [
  "after",
  "backdrop",
  "before",
  "cue",
  "cue-region",
  "first-letter",
  "first-line",
  "grammar-error",
  "marker",
  "part",
  "placeholder",
  "selection",
  "slotted",
  "spelling-error"
].sort().reverse();
var ATTRIBUTES = [
  "accent-color",
  "align-content",
  "align-items",
  "align-self",
  "alignment-baseline",
  "all",
  "anchor-name",
  "animation",
  "animation-composition",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-range",
  "animation-range-end",
  "animation-range-start",
  "animation-timeline",
  "animation-timing-function",
  "appearance",
  "aspect-ratio",
  "backdrop-filter",
  "backface-visibility",
  "background",
  "background-attachment",
  "background-blend-mode",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
  "background-position",
  "background-position-x",
  "background-position-y",
  "background-repeat",
  "background-size",
  "baseline-shift",
  "block-size",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-end-color",
  "border-block-end-style",
  "border-block-end-width",
  "border-block-start",
  "border-block-start-color",
  "border-block-start-style",
  "border-block-start-width",
  "border-block-style",
  "border-block-width",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-end-end-radius",
  "border-end-start-radius",
  "border-image",
  "border-image-outset",
  "border-image-repeat",
  "border-image-slice",
  "border-image-source",
  "border-image-width",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-end-color",
  "border-inline-end-style",
  "border-inline-end-width",
  "border-inline-start",
  "border-inline-start-color",
  "border-inline-start-style",
  "border-inline-start-width",
  "border-inline-style",
  "border-inline-width",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-start-end-radius",
  "border-start-start-radius",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-align",
  "box-decoration-break",
  "box-direction",
  "box-flex",
  "box-flex-group",
  "box-lines",
  "box-ordinal-group",
  "box-orient",
  "box-pack",
  "box-shadow",
  "box-sizing",
  "break-after",
  "break-before",
  "break-inside",
  "caption-side",
  "caret-color",
  "clear",
  "clip",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "color-scheme",
  "column-count",
  "column-fill",
  "column-gap",
  "column-rule",
  "column-rule-color",
  "column-rule-style",
  "column-rule-width",
  "column-span",
  "column-width",
  "columns",
  "contain",
  "contain-intrinsic-block-size",
  "contain-intrinsic-height",
  "contain-intrinsic-inline-size",
  "contain-intrinsic-size",
  "contain-intrinsic-width",
  "container",
  "container-name",
  "container-type",
  "content",
  "content-visibility",
  "corner-bottom-left-shape",
  "corner-bottom-right-shape",
  "corner-shape",
  "corner-top-left-shape",
  "corner-top-right-shape",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "cue",
  "cue-after",
  "cue-before",
  "cursor",
  "cx",
  "cy",
  "direction",
  "display",
  "dominant-baseline",
  "empty-cells",
  "enable-background",
  "field-sizing",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "float",
  "flood-color",
  "flood-opacity",
  "flow",
  "font",
  "font-display",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-smooth",
  "font-smoothing",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-synthesis-position",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "forced-color-adjust",
  "gap",
  "glyph-orientation-horizontal",
  "glyph-orientation-vertical",
  "grid",
  "grid-area",
  "grid-auto-columns",
  "grid-auto-flow",
  "grid-auto-rows",
  "grid-column",
  "grid-column-end",
  "grid-column-start",
  "grid-gap",
  "grid-row",
  "grid-row-end",
  "grid-row-start",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "hanging-punctuation",
  "height",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "icon",
  "image-orientation",
  "image-rendering",
  "image-resolution",
  "ime-mode",
  "initial-letter",
  "initial-letter-align",
  "inline-size",
  "inset",
  "inset-area",
  "inset-block",
  "inset-block-end",
  "inset-block-start",
  "inset-inline",
  "inset-inline-end",
  "inset-inline-start",
  "isolation",
  "justify-content",
  "justify-items",
  "justify-self",
  "kerning",
  "left",
  "letter-spacing",
  "lighting-color",
  "line-break",
  "line-height",
  "line-height-step",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-block",
  "margin-block-end",
  "margin-block-start",
  "margin-bottom",
  "margin-inline",
  "margin-inline-end",
  "margin-inline-start",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-trim",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "marks",
  "mask",
  "mask-border",
  "mask-border-mode",
  "mask-border-outset",
  "mask-border-repeat",
  "mask-border-slice",
  "mask-border-source",
  "mask-border-width",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "mask-type",
  "masonry-auto-flow",
  "math-depth",
  "math-shift",
  "math-style",
  "max-block-size",
  "max-height",
  "max-inline-size",
  "max-width",
  "min-block-size",
  "min-height",
  "min-inline-size",
  "min-width",
  "mix-blend-mode",
  "nav-down",
  "nav-index",
  "nav-left",
  "nav-right",
  "nav-up",
  "none",
  "normal",
  "object-fit",
  "object-position",
  "offset",
  "offset-anchor",
  "offset-distance",
  "offset-path",
  "offset-position",
  "offset-rotate",
  "opacity",
  "order",
  "orphans",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow",
  "overflow-anchor",
  "overflow-block",
  "overflow-clip-margin",
  "overflow-inline",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "overlay",
  "overscroll-behavior",
  "overscroll-behavior-block",
  "overscroll-behavior-inline",
  "overscroll-behavior-x",
  "overscroll-behavior-y",
  "padding",
  "padding-block",
  "padding-block-end",
  "padding-block-start",
  "padding-bottom",
  "padding-inline",
  "padding-inline-end",
  "padding-inline-start",
  "padding-left",
  "padding-right",
  "padding-top",
  "page",
  "page-break-after",
  "page-break-before",
  "page-break-inside",
  "paint-order",
  "pause",
  "pause-after",
  "pause-before",
  "perspective",
  "perspective-origin",
  "place-content",
  "place-items",
  "place-self",
  "pointer-events",
  "position",
  "position-anchor",
  "position-visibility",
  "print-color-adjust",
  "quotes",
  "r",
  "resize",
  "rest",
  "rest-after",
  "rest-before",
  "right",
  "rotate",
  "row-gap",
  "ruby-align",
  "ruby-position",
  "scale",
  "scroll-behavior",
  "scroll-margin",
  "scroll-margin-block",
  "scroll-margin-block-end",
  "scroll-margin-block-start",
  "scroll-margin-bottom",
  "scroll-margin-inline",
  "scroll-margin-inline-end",
  "scroll-margin-inline-start",
  "scroll-margin-left",
  "scroll-margin-right",
  "scroll-margin-top",
  "scroll-padding",
  "scroll-padding-block",
  "scroll-padding-block-end",
  "scroll-padding-block-start",
  "scroll-padding-bottom",
  "scroll-padding-inline",
  "scroll-padding-inline-end",
  "scroll-padding-inline-start",
  "scroll-padding-left",
  "scroll-padding-right",
  "scroll-padding-top",
  "scroll-snap-align",
  "scroll-snap-stop",
  "scroll-snap-type",
  "scroll-timeline",
  "scroll-timeline-axis",
  "scroll-timeline-name",
  "scrollbar-color",
  "scrollbar-gutter",
  "scrollbar-width",
  "shape-image-threshold",
  "shape-margin",
  "shape-outside",
  "shape-rendering",
  "speak",
  "speak-as",
  "src",
  // @font-face
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "table-layout",
  "text-align",
  "text-align-all",
  "text-align-last",
  "text-anchor",
  "text-combine-upright",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-skip",
  "text-decoration-skip-ink",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-emphasis",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-justify",
  "text-orientation",
  "text-overflow",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "timeline-scope",
  "top",
  "touch-action",
  "transform",
  "transform-box",
  "transform-origin",
  "transform-style",
  "transition",
  "transition-behavior",
  "transition-delay",
  "transition-duration",
  "transition-property",
  "transition-timing-function",
  "translate",
  "unicode-bidi",
  "unicode-range",
  "user-modify",
  "user-select",
  "vector-effect",
  "vertical-align",
  "view-timeline",
  "view-timeline-axis",
  "view-timeline-inset",
  "view-timeline-name",
  "view-transition-name",
  "visibility",
  "voice-balance",
  "voice-duration",
  "voice-family",
  "voice-pitch",
  "voice-range",
  "voice-rate",
  "voice-stress",
  "voice-volume",
  "white-space",
  "white-space-collapse",
  "widows",
  "width",
  "will-change",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "x",
  "y",
  "z-index",
  "zoom"
].sort().reverse();
function css(hljs) {
  const regex = hljs.regex;
  const modes = MODES(hljs);
  const VENDOR_PREFIX = { begin: /-(webkit|moz|ms|o)-(?=[a-z])/ };
  const AT_MODIFIERS = "and or not only";
  const AT_PROPERTY_RE = /@-?\w[\w]*(-\w+)*/;
  const IDENT_RE3 = "[a-zA-Z-][a-zA-Z0-9_-]*";
  const STRINGS = [
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE
  ];
  return {
    name: "CSS",
    case_insensitive: true,
    illegal: /[=|'\$]/,
    keywords: { keyframePosition: "from to" },
    classNameAliases: {
      // for visual continuity with `tag {}` and because we
      // don't have a great class for this?
      keyframePosition: "selector-tag"
    },
    contains: [
      modes.BLOCK_COMMENT,
      VENDOR_PREFIX,
      // to recognize keyframe 40% etc which are outside the scope of our
      // attribute value mode
      modes.CSS_NUMBER_MODE,
      {
        className: "selector-id",
        begin: /#[A-Za-z0-9_-]+/,
        relevance: 0
      },
      {
        className: "selector-class",
        begin: "\\." + IDENT_RE3,
        relevance: 0
      },
      modes.ATTRIBUTE_SELECTOR_MODE,
      {
        className: "selector-pseudo",
        variants: [
          { begin: ":(" + PSEUDO_CLASSES.join("|") + ")" },
          { begin: ":(:)?(" + PSEUDO_ELEMENTS.join("|") + ")" }
        ]
      },
      // we may actually need this (12/2020)
      // { // pseudo-selector params
      //   begin: /\(/,
      //   end: /\)/,
      //   contains: [ hljs.CSS_NUMBER_MODE ]
      // },
      modes.CSS_VARIABLE,
      {
        className: "attribute",
        begin: "\\b(" + ATTRIBUTES.join("|") + ")\\b"
      },
      // attribute values
      {
        begin: /:/,
        end: /[;}{]/,
        contains: [
          modes.BLOCK_COMMENT,
          modes.HEXCOLOR,
          modes.IMPORTANT,
          modes.CSS_NUMBER_MODE,
          modes.UNICODE_RANGE,
          ...STRINGS,
          // needed to highlight these as strings and to avoid issues with
          // illegal characters that might be inside urls that would trigger the
          // languages illegal stack
          {
            begin: /(url|data-uri)\(/,
            end: /\)/,
            relevance: 0,
            // from keywords
            keywords: { built_in: "url data-uri" },
            contains: [
              ...STRINGS,
              {
                className: "string",
                // any character other than `)` as in `url()` will be the start
                // of a string, which ends with `)` (from the parent mode)
                begin: /[^)]/,
                endsWithParent: true,
                excludeEnd: true
              }
            ]
          },
          modes.FUNCTION_DISPATCH
        ]
      },
      {
        begin: regex.lookahead(/@/),
        end: "[{;]",
        relevance: 0,
        illegal: /:/,
        // break on Less variables @var: ...
        contains: [
          {
            className: "keyword",
            begin: AT_PROPERTY_RE
          },
          {
            begin: /\s/,
            endsWithParent: true,
            excludeEnd: true,
            relevance: 0,
            keywords: {
              $pattern: /[a-z-]+/,
              keyword: AT_MODIFIERS,
              attribute: MEDIA_FEATURES.join(" ")
            },
            contains: [
              {
                begin: /[a-z-]+(?=:)/,
                className: "attribute"
              },
              ...STRINGS,
              modes.CSS_NUMBER_MODE
            ]
          }
        ]
      },
      {
        className: "selector-tag",
        begin: "\\b(" + TAGS.join("|") + ")\\b"
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/diff.js
function diff(hljs) {
  const regex = hljs.regex;
  return {
    name: "Diff",
    aliases: ["patch"],
    contains: [
      {
        className: "meta",
        relevance: 10,
        match: regex.either(
          /^@@ +-\d+,\d+ +\+\d+,\d+ +@@/,
          // @@ -1,2 +1,2 @@
          /^@@ +-\d+ +\+\d+,\d+ +@@/,
          // @@ -1 +1,2 @@
          /^@@ +-\d+,\d+ +\+\d+ +@@/,
          // @@ -1,2 +1 @@
          /^@@ +-\d+ +\+\d+ +@@/,
          // @@ -1 +1 @@
          /^\*\*\* +\d+,\d+ +\*\*\*\*$/,
          /^--- +\d+,\d+ +----$/
        )
      },
      {
        className: "comment",
        variants: [
          {
            begin: regex.either(
              /Index: /,
              /^index/,
              /={3,}/,
              /^-{3}/,
              /^\*{3} /,
              /^\+{3}/,
              /^diff --git/
            ),
            end: /$/
          },
          { match: /^\*{15}$/ }
        ]
      },
      {
        className: "addition",
        begin: /^\+/,
        end: /$/
      },
      {
        className: "deletion",
        begin: /^-/,
        end: /$/
      },
      {
        className: "addition",
        begin: /^!/,
        end: /$/
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/dockerfile.js
function dockerfile(hljs) {
  const KEYWORDS3 = [
    "from",
    "maintainer",
    "expose",
    "env",
    "arg",
    "user",
    "onbuild",
    "stopsignal"
  ];
  return {
    name: "Dockerfile",
    aliases: ["docker"],
    case_insensitive: true,
    keywords: KEYWORDS3,
    contains: [
      hljs.HASH_COMMENT_MODE,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.NUMBER_MODE,
      {
        beginKeywords: "run cmd entrypoint volume add copy workdir label healthcheck shell",
        starts: {
          end: /[^\\]$/,
          subLanguage: "bash"
        }
      }
    ],
    illegal: "</"
  };
}

// node_modules/highlight.js/es/languages/go.js
function go(hljs) {
  const LITERALS3 = [
    "true",
    "false",
    "iota",
    "nil"
  ];
  const BUILT_INS3 = [
    "append",
    "cap",
    "close",
    "complex",
    "copy",
    "imag",
    "len",
    "make",
    "new",
    "panic",
    "print",
    "println",
    "real",
    "recover",
    "delete"
  ];
  const TYPES3 = [
    "bool",
    "byte",
    "complex64",
    "complex128",
    "error",
    "float32",
    "float64",
    "int8",
    "int16",
    "int32",
    "int64",
    "string",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "int",
    "uint",
    "uintptr",
    "rune"
  ];
  const KWS = [
    "break",
    "case",
    "chan",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "fallthrough",
    "for",
    "func",
    "go",
    "goto",
    "if",
    "import",
    "interface",
    "map",
    "package",
    "range",
    "return",
    "select",
    "struct",
    "switch",
    "type",
    "var"
  ];
  const KEYWORDS3 = {
    keyword: KWS,
    type: TYPES3,
    literal: LITERALS3,
    built_in: BUILT_INS3
  };
  return {
    name: "Go",
    aliases: ["golang"],
    keywords: KEYWORDS3,
    illegal: "</",
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      {
        className: "string",
        variants: [
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          {
            begin: "`",
            end: "`"
          }
        ]
      },
      {
        className: "number",
        variants: [
          {
            match: /-?\b0[xX]\.[a-fA-F0-9](_?[a-fA-F0-9])*[pP][+-]?\d(_?\d)*i?/,
            // hex without a present digit before . (making a digit afterwards required)
            relevance: 0
          },
          {
            match: /-?\b0[xX](_?[a-fA-F0-9])+((\.([a-fA-F0-9](_?[a-fA-F0-9])*)?)?[pP][+-]?\d(_?\d)*)?i?/,
            // hex with a present digit before . (making a digit afterwards optional)
            relevance: 0
          },
          {
            match: /-?\b0[oO](_?[0-7])*i?/,
            // leading 0o octal
            relevance: 0
          },
          {
            match: /-?\b0[bB](_?[01])*i?/,
            // leading 0b binary
            relevance: 0
          },
          {
            match: /-?\.\d(_?\d)*([eE][+-]?\d(_?\d)*)?i?/,
            // decimal without a present digit before . (making a digit afterwards required)
            relevance: 0
          },
          {
            match: /-?\b\d(_?\d)*(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?i?/,
            // decimal with a present digit before . (making a digit afterwards optional)
            relevance: 0
          }
        ]
      },
      {
        begin: /:=/
        // relevance booster
      },
      {
        className: "function",
        beginKeywords: "func",
        end: "\\s*(\\{|$)",
        excludeEnd: true,
        contains: [
          hljs.TITLE_MODE,
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            endsParent: true,
            keywords: KEYWORDS3,
            illegal: /["']/
          }
        ]
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/graphql.js
function graphql(hljs) {
  const regex = hljs.regex;
  const GQL_NAME = /[_A-Za-z][_0-9A-Za-z]*/;
  return {
    name: "GraphQL",
    aliases: ["gql"],
    case_insensitive: true,
    disableAutodetect: false,
    keywords: {
      keyword: [
        "query",
        "mutation",
        "subscription",
        "type",
        "input",
        "schema",
        "directive",
        "interface",
        "union",
        "scalar",
        "fragment",
        "enum",
        "on"
      ],
      literal: [
        "true",
        "false",
        "null"
      ]
    },
    contains: [
      hljs.HASH_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.NUMBER_MODE,
      {
        scope: "punctuation",
        match: /[.]{3}/,
        relevance: 0
      },
      {
        scope: "punctuation",
        begin: /[\!\(\)\:\=\[\]\{\|\}]{1}/,
        relevance: 0
      },
      {
        scope: "variable",
        begin: /\$/,
        end: /\W/,
        excludeEnd: true,
        relevance: 0
      },
      {
        scope: "meta",
        match: /@\w+/,
        excludeEnd: true
      },
      {
        scope: "symbol",
        begin: regex.concat(GQL_NAME, regex.lookahead(/\s*:/)),
        relevance: 0
      }
    ],
    illegal: [
      /[;<']/,
      /BEGIN/
    ]
  };
}

// node_modules/highlight.js/es/languages/ini.js
function ini(hljs) {
  const regex = hljs.regex;
  const NUMBERS = {
    className: "number",
    relevance: 0,
    variants: [
      { begin: /([+-]+)?[\d]+_[\d_]+/ },
      { begin: hljs.NUMBER_RE }
    ]
  };
  const COMMENTS = hljs.COMMENT();
  COMMENTS.variants = [
    {
      begin: /;/,
      end: /$/
    },
    {
      begin: /#/,
      end: /$/
    }
  ];
  const VARIABLES = {
    className: "variable",
    variants: [
      { begin: /\$[\w\d"][\w\d_]*/ },
      { begin: /\$\{(.*?)\}/ }
    ]
  };
  const LITERALS3 = {
    className: "literal",
    begin: /\bon|off|true|false|yes|no\b/
  };
  const STRINGS = {
    className: "string",
    contains: [hljs.BACKSLASH_ESCAPE],
    variants: [
      {
        begin: "'''",
        end: "'''",
        relevance: 10
      },
      {
        begin: '"""',
        end: '"""',
        relevance: 10
      },
      {
        begin: '"',
        end: '"'
      },
      {
        begin: "'",
        end: "'"
      }
    ]
  };
  const ARRAY = {
    begin: /\[/,
    end: /\]/,
    contains: [
      COMMENTS,
      LITERALS3,
      VARIABLES,
      STRINGS,
      NUMBERS,
      "self"
    ],
    relevance: 0
  };
  const BARE_KEY = /[A-Za-z0-9_-]+/;
  const QUOTED_KEY_DOUBLE_QUOTE = /"(\\"|[^"])*"/;
  const QUOTED_KEY_SINGLE_QUOTE = /'[^']*'/;
  const ANY_KEY = regex.either(
    BARE_KEY,
    QUOTED_KEY_DOUBLE_QUOTE,
    QUOTED_KEY_SINGLE_QUOTE
  );
  const DOTTED_KEY = regex.concat(
    ANY_KEY,
    "(\\s*\\.\\s*",
    ANY_KEY,
    ")*",
    regex.lookahead(/\s*=\s*[^#\s]/)
  );
  return {
    name: "TOML, also INI",
    aliases: ["toml"],
    case_insensitive: true,
    illegal: /\S/,
    contains: [
      COMMENTS,
      {
        className: "section",
        begin: /\[+/,
        end: /\]+/
      },
      {
        begin: DOTTED_KEY,
        className: "attr",
        starts: {
          end: /$/,
          contains: [
            COMMENTS,
            ARRAY,
            LITERALS3,
            VARIABLES,
            STRINGS,
            NUMBERS
          ]
        }
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/java.js
var decimalDigits = "[0-9](_*[0-9])*";
var frac = `\\.(${decimalDigits})`;
var hexDigits = "[0-9a-fA-F](_*[0-9a-fA-F])*";
var NUMERIC = {
  className: "number",
  variants: [
    // DecimalFloatingPointLiteral
    // including ExponentPart
    { begin: `(\\b(${decimalDigits})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})[fFdD]?\\b` },
    // excluding ExponentPart
    { begin: `\\b(${decimalDigits})((${frac})[fFdD]?\\b|\\.([fFdD]\\b)?)` },
    { begin: `(${frac})[fFdD]?\\b` },
    { begin: `\\b(${decimalDigits})[fFdD]\\b` },
    // HexadecimalFloatingPointLiteral
    { begin: `\\b0[xX]((${hexDigits})\\.?|(${hexDigits})?\\.(${hexDigits}))[pP][+-]?(${decimalDigits})[fFdD]?\\b` },
    // DecimalIntegerLiteral
    { begin: "\\b(0|[1-9](_*[0-9])*)[lL]?\\b" },
    // HexIntegerLiteral
    { begin: `\\b0[xX](${hexDigits})[lL]?\\b` },
    // OctalIntegerLiteral
    { begin: "\\b0(_*[0-7])*[lL]?\\b" },
    // BinaryIntegerLiteral
    { begin: "\\b0[bB][01](_*[01])*[lL]?\\b" }
  ],
  relevance: 0
};
function recurRegex(re, substitution, depth) {
  if (depth === -1) return "";
  return re.replace(substitution, (_) => {
    return recurRegex(re, substitution, depth - 1);
  });
}
function java(hljs) {
  const regex = hljs.regex;
  const JAVA_IDENT_RE = "[\xC0-\u02B8a-zA-Z_$][\xC0-\u02B8a-zA-Z_$0-9]*";
  const ARRAY_BRACKETS_OPTIONAL_RE = "(?:(?:\\s*\\[\\s*])+)?";
  const SIMPLE_TYPE_RE = JAVA_IDENT_RE + "<@@@>" + ARRAY_BRACKETS_OPTIONAL_RE;
  const WILDCARD_TYPE_RE = "\\?(?:\\s+(?:extends|super)\\s+" + SIMPLE_TYPE_RE + ")?";
  const TYPE_ARG_RE = "(?:" + WILDCARD_TYPE_RE + "|" + SIMPLE_TYPE_RE + ")";
  const TYPE_ARGS_OPTIONAL_RE = recurRegex(
    "(?:\\s*<\\s*" + TYPE_ARG_RE + "(?:\\s*,\\s*" + TYPE_ARG_RE + ")*\\s*>)?",
    /<@@@>/g,
    2
  );
  const MAIN_KEYWORDS = [
    "synchronized",
    "abstract",
    "private",
    "var",
    "static",
    "if",
    "const ",
    "for",
    "while",
    "strictfp",
    "finally",
    "protected",
    "import",
    "native",
    "final",
    "void",
    "enum",
    "else",
    "break",
    "transient",
    "catch",
    "instanceof",
    "volatile",
    "case",
    "assert",
    "package",
    "default",
    "public",
    "try",
    "switch",
    "continue",
    "throws",
    "protected",
    "public",
    "private",
    "module",
    "requires",
    "exports",
    "do",
    "sealed",
    "yield",
    "permits",
    "goto",
    "when"
  ];
  const BUILT_INS3 = [
    "super",
    "this"
  ];
  const LITERALS3 = [
    "false",
    "true",
    "null"
  ];
  const TYPES3 = [
    "char",
    "boolean",
    "long",
    "float",
    "int",
    "byte",
    "short",
    "double"
  ];
  const KEYWORDS3 = {
    keyword: MAIN_KEYWORDS,
    literal: LITERALS3,
    type: TYPES3,
    built_in: BUILT_INS3
  };
  const ANNOTATION = {
    className: "meta",
    begin: "@" + JAVA_IDENT_RE,
    contains: [
      {
        begin: /\(/,
        end: /\)/,
        contains: ["self"]
        // allow nested () inside our annotation
      }
    ]
  };
  const PARAMS = {
    className: "params",
    begin: /\(/,
    end: /\)/,
    keywords: KEYWORDS3,
    relevance: 0,
    contains: [hljs.C_BLOCK_COMMENT_MODE],
    endsParent: true
  };
  return {
    name: "Java",
    aliases: ["jsp"],
    keywords: KEYWORDS3,
    illegal: /<\/|#/,
    contains: [
      hljs.COMMENT(
        "/\\*\\*",
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              // eat up @'s in emails to prevent them to be recognized as doctags
              begin: /\w+@/,
              relevance: 0
            },
            {
              className: "doctag",
              begin: "@[A-Za-z]+"
            }
          ]
        }
      ),
      // relevance boost
      {
        begin: /import java\.[a-z]+\./,
        keywords: "import",
        relevance: 2
      },
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      {
        begin: /"""/,
        end: /"""/,
        className: "string",
        contains: [hljs.BACKSLASH_ESCAPE]
      },
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      {
        match: [
          /\b(?:class|interface|enum|extends|implements|new)/,
          /\s+/,
          JAVA_IDENT_RE
        ],
        className: {
          1: "keyword",
          3: "title.class"
        }
      },
      {
        // Exceptions for hyphenated keywords
        match: /non-sealed/,
        scope: "keyword"
      },
      {
        // Expression keywords prevent keyword-led expressions from being
        // recognized as variable or method declarations.
        beginKeywords: "new throw return else yield assert",
        relevance: 0
      },
      {
        begin: [
          JAVA_IDENT_RE,
          regex.concat(TYPE_ARGS_OPTIONAL_RE, ARRAY_BRACKETS_OPTIONAL_RE, /\s+/),
          JAVA_IDENT_RE,
          ARRAY_BRACKETS_OPTIONAL_RE,
          /\s*/,
          /=(?!=)/
        ],
        className: {
          1: "type",
          3: "variable",
          6: "operator"
        }
      },
      {
        begin: [
          /record/,
          /\s+/,
          JAVA_IDENT_RE
        ],
        className: {
          1: "keyword",
          3: "title.class"
        },
        contains: [
          PARAMS,
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      {
        begin: [
          JAVA_IDENT_RE,
          regex.concat(TYPE_ARGS_OPTIONAL_RE, ARRAY_BRACKETS_OPTIONAL_RE, /\s+/),
          JAVA_IDENT_RE,
          /\s*(?=\()/
        ],
        className: {
          1: "type",
          3: "title.function"
        },
        keywords: KEYWORDS3,
        contains: [
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            keywords: KEYWORDS3,
            relevance: 0,
            contains: [
              ANNOTATION,
              hljs.APOS_STRING_MODE,
              hljs.QUOTE_STRING_MODE,
              NUMERIC,
              hljs.C_BLOCK_COMMENT_MODE
            ]
          },
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      NUMERIC,
      ANNOTATION
    ]
  };
}

// node_modules/highlight.js/es/languages/javascript.js
var IDENT_RE = "[A-Za-z$_][0-9A-Za-z$_]*";
var KEYWORDS = [
  "as",
  // for exports
  "in",
  "of",
  "if",
  "for",
  "while",
  "finally",
  "var",
  "new",
  "function",
  "do",
  "return",
  "void",
  "else",
  "break",
  "catch",
  "instanceof",
  "with",
  "throw",
  "case",
  "default",
  "try",
  "switch",
  "continue",
  "typeof",
  "delete",
  "let",
  "yield",
  "const",
  "class",
  // JS handles these with a special rule
  // "get",
  // "set",
  "debugger",
  "async",
  "await",
  "static",
  "import",
  "from",
  "export",
  "extends",
  // It's reached stage 3, which is "recommended for implementation":
  "using"
];
var LITERALS = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity"
];
var TYPES = [
  // Fundamental objects
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  // numbers and dates
  "Math",
  "Date",
  "Number",
  "BigInt",
  // text
  "String",
  "RegExp",
  // Indexed collections
  "Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  // Keyed collections
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  // Structured data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "JSON",
  // Control abstraction objects
  "Promise",
  "Generator",
  "GeneratorFunction",
  "AsyncFunction",
  // Reflection
  "Reflect",
  "Proxy",
  // Internationalization
  "Intl",
  // WebAssembly
  "WebAssembly"
];
var ERROR_TYPES = [
  "Error",
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
];
var BUILT_IN_GLOBALS = [
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
  "require",
  "exports",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape"
];
var BUILT_IN_VARIABLES = [
  "arguments",
  "this",
  "super",
  "console",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "module",
  "self",
  "global"
  // Node.js
];
var BUILT_INS = [].concat(
  BUILT_IN_GLOBALS,
  TYPES,
  ERROR_TYPES
);
function javascript(hljs) {
  const regex = hljs.regex;
  const hasClosingTag = (match, { after }) => {
    const tag = "</" + match[0].slice(1);
    const pos = match.input.indexOf(tag, after);
    return pos !== -1;
  };
  const IDENT_RE$1 = IDENT_RE;
  const FRAGMENT = {
    begin: "<>",
    end: "</>"
  };
  const XML_SELF_CLOSING = /<[A-Za-z0-9\\._:-]+\s*\/>/;
  const XML_TAG = {
    begin: /<[A-Za-z0-9\\._:-]+/,
    end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
    /**
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    isTrulyOpeningTag: (match, response) => {
      const afterMatchIndex = match[0].length + match.index;
      const nextChar = match.input[afterMatchIndex];
      if (
        // HTML should not include another raw `<` inside a tag
        // nested type?
        // `<Array<Array<number>>`, etc.
        nextChar === "<" || // the , gives away that this is not HTML
        // `<T, A extends keyof T, V>`
        nextChar === ","
      ) {
        response.ignoreMatch();
        return;
      }
      if (nextChar === ">") {
        if (!hasClosingTag(match, { after: afterMatchIndex })) {
          response.ignoreMatch();
        }
      }
      let m;
      const afterMatch = match.input.substring(afterMatchIndex);
      if (m = afterMatch.match(/^\s*=/)) {
        response.ignoreMatch();
        return;
      }
      if (m = afterMatch.match(/^\s+extends\s+/)) {
        if (m.index === 0) {
          response.ignoreMatch();
          return;
        }
      }
    }
  };
  const KEYWORDS$1 = {
    $pattern: IDENT_RE,
    keyword: KEYWORDS,
    literal: LITERALS,
    built_in: BUILT_INS,
    "variable.language": BUILT_IN_VARIABLES
  };
  const decimalDigits3 = "[0-9](_?[0-9])*";
  const frac3 = `\\.(${decimalDigits3})`;
  const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
  const NUMBER = {
    className: "number",
    variants: [
      // DecimalLiteral
      { begin: `(\\b(${decimalInteger})((${frac3})|\\.)?|(${frac3}))[eE][+-]?(${decimalDigits3})\\b` },
      { begin: `\\b(${decimalInteger})\\b((${frac3})\\b|\\.)?|(${frac3})\\b` },
      // DecimalBigIntegerLiteral
      { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
      // NonDecimalIntegerLiteral
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
      // LegacyOctalIntegerLiteral (does not include underscore separators)
      // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
      { begin: "\\b0[0-7]+n?\\b" }
    ],
    relevance: 0
  };
  const SUBST = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: KEYWORDS$1,
    contains: []
    // defined later
  };
  const HTML_TEMPLATE = {
    begin: ".?html`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "xml"
    }
  };
  const CSS_TEMPLATE = {
    begin: ".?css`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "css"
    }
  };
  const GRAPHQL_TEMPLATE = {
    begin: ".?gql`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "graphql"
    }
  };
  const TEMPLATE_STRING = {
    className: "string",
    begin: "`",
    end: "`",
    contains: [
      hljs.BACKSLASH_ESCAPE,
      SUBST
    ]
  };
  const JSDOC_COMMENT = hljs.COMMENT(
    /\/\*\*(?!\/)/,
    "\\*/",
    {
      relevance: 0,
      contains: [
        {
          begin: "(?=@[A-Za-z]+)",
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+"
            },
            {
              className: "type",
              begin: "\\{",
              end: "\\}",
              excludeEnd: true,
              excludeBegin: true,
              relevance: 0
            },
            {
              className: "variable",
              begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
              endsParent: true,
              relevance: 0
            },
            // eat spaces (not newlines) so we can find
            // types or variables
            {
              begin: /(?=[^\n])\s/,
              relevance: 0
            }
          ]
        }
      ]
    }
  );
  const COMMENT = {
    className: "comment",
    variants: [
      JSDOC_COMMENT,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE
    ]
  };
  const SUBST_INTERNALS = [
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE,
    HTML_TEMPLATE,
    CSS_TEMPLATE,
    GRAPHQL_TEMPLATE,
    TEMPLATE_STRING,
    // Skip numbers when they are part of a variable name
    { match: /\$\d+/ },
    NUMBER
    // This is intentional:
    // See https://github.com/highlightjs/highlight.js/issues/3288
    // hljs.REGEXP_MODE
  ];
  SUBST.contains = SUBST_INTERNALS.concat({
    // we need to pair up {} inside our subst to prevent
    // it from ending too early by matching another }
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS$1,
    contains: [
      "self"
    ].concat(SUBST_INTERNALS)
  });
  const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
  const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
    // eat recursive parens in sub expressions
    {
      begin: /(\s*)\(/,
      end: /\)/,
      keywords: KEYWORDS$1,
      contains: ["self"].concat(SUBST_AND_COMMENTS)
    }
  ]);
  const PARAMS = {
    className: "params",
    // convert this to negative lookbehind in v12
    begin: /(\s*)\(/,
    // to match the parms with
    end: /\)/,
    excludeBegin: true,
    excludeEnd: true,
    keywords: KEYWORDS$1,
    contains: PARAMS_CONTAINS
  };
  const CLASS_OR_EXTENDS = {
    variants: [
      // class Car extends vehicle
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1,
          /\s+/,
          /extends/,
          /\s+/,
          regex.concat(IDENT_RE$1, "(", regex.concat(/\./, IDENT_RE$1), ")*")
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          5: "keyword",
          7: "title.class.inherited"
        }
      },
      // class Car
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      }
    ]
  };
  const CLASS_REFERENCE = {
    relevance: 0,
    match: regex.either(
      // Hard coded exceptions
      /\bJSON/,
      // Float32Array, OutT
      /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
      // CSSFactory, CSSFactoryT
      /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
      // FPs, FPsT
      /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
      // P
      // single letters are not highlighted
      // BLAH
      // this will be flagged as a UPPER_CASE_CONSTANT instead
    ),
    className: "title.class",
    keywords: {
      _: [
        // se we still get relevance credit for JS library classes
        ...TYPES,
        ...ERROR_TYPES
      ]
    }
  };
  const USE_STRICT = {
    label: "use_strict",
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use (strict|asm)['"]/
  };
  const FUNCTION_DEFINITION = {
    variants: [
      {
        match: [
          /function/,
          /\s+/,
          IDENT_RE$1,
          /(?=\s*\()/
        ]
      },
      // anonymous function
      {
        match: [
          /function/,
          /\s*(?=\()/
        ]
      }
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    label: "func.def",
    contains: [PARAMS],
    illegal: /%/
  };
  const UPPER_CASE_CONSTANT = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  function noneOf(list) {
    return regex.concat("(?!", list.join("|"), ")");
  }
  const FUNCTION_CALL = {
    match: regex.concat(
      /\b/,
      noneOf([
        ...BUILT_IN_GLOBALS,
        "super",
        "import",
        "await"
      ].map((x) => `${x}\\s*\\(`)),
      IDENT_RE$1,
      regex.lookahead(/\s*\(/)
    ),
    className: "title.function",
    relevance: 0
  };
  const PROPERTY_ACCESS = {
    begin: regex.concat(/\./, regex.lookahead(
      regex.concat(IDENT_RE$1, /(?![0-9A-Za-z$_(])/)
    )),
    end: IDENT_RE$1,
    excludeBegin: true,
    keywords: "prototype",
    className: "property",
    relevance: 0
  };
  const GETTER_OR_SETTER = {
    match: [
      /get|set/,
      /\s+/,
      IDENT_RE$1,
      /(?=\()/
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      {
        // eat to avoid empty params
        begin: /\(\)/
      },
      PARAMS
    ]
  };
  const FUNC_LEAD_IN_RE = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs.UNDERSCORE_IDENT_RE + ")\\s*=>";
  const FUNCTION_VARIABLE = {
    match: [
      /const|var|let/,
      /\s+/,
      IDENT_RE$1,
      /\s*/,
      /=\s*/,
      /(async\s*)?/,
      // async is optional
      regex.lookahead(FUNC_LEAD_IN_RE)
    ],
    keywords: "async",
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      PARAMS
    ]
  };
  return {
    name: "JavaScript",
    aliases: ["js", "jsx", "mjs", "cjs"],
    keywords: KEYWORDS$1,
    // this will be extended by TypeScript
    exports: { PARAMS_CONTAINS, CLASS_REFERENCE },
    illegal: /#(?![$_A-Za-z])/,
    contains: [
      hljs.SHEBANG({
        label: "shebang",
        binary: "node",
        relevance: 5
      }),
      USE_STRICT,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      HTML_TEMPLATE,
      CSS_TEMPLATE,
      GRAPHQL_TEMPLATE,
      TEMPLATE_STRING,
      COMMENT,
      // Skip numbers when they are part of a variable name
      { match: /\$\d+/ },
      NUMBER,
      CLASS_REFERENCE,
      {
        scope: "attr",
        match: IDENT_RE$1 + regex.lookahead(":"),
        relevance: 0
      },
      FUNCTION_VARIABLE,
      {
        // "value" container
        begin: "(" + hljs.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
        keywords: "return throw case",
        relevance: 0,
        contains: [
          COMMENT,
          hljs.REGEXP_MODE,
          {
            className: "function",
            // we have to count the parens to make sure we actually have the
            // correct bounding ( ) before the =>.  There could be any number of
            // sub-expressions inside also surrounded by parens.
            begin: FUNC_LEAD_IN_RE,
            returnBegin: true,
            end: "\\s*=>",
            contains: [
              {
                className: "params",
                variants: [
                  {
                    begin: hljs.UNDERSCORE_IDENT_RE,
                    relevance: 0
                  },
                  {
                    className: null,
                    begin: /\(\s*\)/,
                    skip: true
                  },
                  {
                    begin: /(\s*)\(/,
                    end: /\)/,
                    excludeBegin: true,
                    excludeEnd: true,
                    keywords: KEYWORDS$1,
                    contains: PARAMS_CONTAINS
                  }
                ]
              }
            ]
          },
          {
            // could be a comma delimited list of params to a function call
            begin: /,/,
            relevance: 0
          },
          {
            match: /\s+/,
            relevance: 0
          },
          {
            // JSX
            variants: [
              { begin: FRAGMENT.begin, end: FRAGMENT.end },
              { match: XML_SELF_CLOSING },
              {
                begin: XML_TAG.begin,
                // we carefully check the opening tag to see if it truly
                // is a tag and not a false positive
                "on:begin": XML_TAG.isTrulyOpeningTag,
                end: XML_TAG.end
              }
            ],
            subLanguage: "xml",
            contains: [
              {
                begin: XML_TAG.begin,
                end: XML_TAG.end,
                skip: true,
                contains: ["self"]
              }
            ]
          }
        ]
      },
      FUNCTION_DEFINITION,
      {
        // prevent this from getting swallowed up by function
        // since they appear "function like"
        beginKeywords: "while if switch catch for"
      },
      {
        // we have to count the parens to make sure we actually have the correct
        // bounding ( ).  There could be any number of sub-expressions inside
        // also surrounded by parens.
        begin: "\\b(?!function)" + hljs.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
        // end parens
        returnBegin: true,
        label: "func.def",
        contains: [
          PARAMS,
          hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1, className: "title.function" })
        ]
      },
      // catch ... so it won't trigger the property rule below
      {
        match: /\.\.\./,
        relevance: 0
      },
      PROPERTY_ACCESS,
      // hack: prevents detection of keywords in some circumstances
      // .keyword()
      // $keyword = x
      {
        match: "\\$" + IDENT_RE$1,
        relevance: 0
      },
      {
        match: [/\bconstructor(?=\s*\()/],
        className: { 1: "title.function" },
        contains: [PARAMS]
      },
      FUNCTION_CALL,
      UPPER_CASE_CONSTANT,
      CLASS_OR_EXTENDS,
      GETTER_OR_SETTER,
      {
        match: /\$[(.]/
        // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/json.js
var EXTENDED_NUMBER_RE = "([-+]?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)|NaN|[-+]?Infinity";
var EXTENDED_NUMBER_MODE = {
  scope: "number",
  match: EXTENDED_NUMBER_RE,
  relevance: 0
};
function json(hljs) {
  const ATTRIBUTE = {
    className: "attr",
    begin: /(("(\\.|[^\\"\r\n])*")|('(\\.|[^\\'\r\n])*'))(?=\s*:)/,
    relevance: 1.01
  };
  const PUNCTUATION = {
    match: /[{}[\],:]/,
    className: "punctuation",
    relevance: 0
  };
  const LITERALS3 = [
    "true",
    "false",
    "null"
  ];
  const LITERALS_MODE = {
    scope: "literal",
    beginKeywords: LITERALS3.join(" ")
  };
  return {
    name: "JSON",
    aliases: ["jsonc", "json5"],
    keywords: {
      literal: LITERALS3
    },
    contains: [
      ATTRIBUTE,
      PUNCTUATION,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      LITERALS_MODE,
      EXTENDED_NUMBER_MODE,
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ],
    illegal: "\\S"
  };
}

// node_modules/highlight.js/es/languages/kotlin.js
var decimalDigits2 = "[0-9](_*[0-9])*";
var frac2 = `\\.(${decimalDigits2})`;
var hexDigits2 = "[0-9a-fA-F](_*[0-9a-fA-F])*";
var NUMERIC2 = {
  className: "number",
  variants: [
    // DecimalFloatingPointLiteral
    // including ExponentPart
    { begin: `(\\b(${decimalDigits2})((${frac2})|\\.)?|(${frac2}))[eE][+-]?(${decimalDigits2})[fFdD]?\\b` },
    // excluding ExponentPart
    { begin: `\\b(${decimalDigits2})((${frac2})[fFdD]?\\b|\\.([fFdD]\\b)?)` },
    { begin: `(${frac2})[fFdD]?\\b` },
    { begin: `\\b(${decimalDigits2})[fFdD]\\b` },
    // HexadecimalFloatingPointLiteral
    { begin: `\\b0[xX]((${hexDigits2})\\.?|(${hexDigits2})?\\.(${hexDigits2}))[pP][+-]?(${decimalDigits2})[fFdD]?\\b` },
    // DecimalIntegerLiteral
    { begin: "\\b(0|[1-9](_*[0-9])*)[lL]?\\b" },
    // HexIntegerLiteral
    { begin: `\\b0[xX](${hexDigits2})[lL]?\\b` },
    // OctalIntegerLiteral
    { begin: "\\b0(_*[0-7])*[lL]?\\b" },
    // BinaryIntegerLiteral
    { begin: "\\b0[bB][01](_*[01])*[lL]?\\b" }
  ],
  relevance: 0
};
function kotlin(hljs) {
  const KEYWORDS3 = {
    keyword: "abstract as val var vararg get set class object open private protected public noinline crossinline dynamic final enum if else do while for when throw try catch finally import package is in fun override companion reified inline lateinit init interface annotation data sealed internal infix operator out by constructor super tailrec where const inner suspend typealias external expect actual",
    built_in: "Byte Short Char Int Long Boolean Float Double Void Unit Nothing",
    literal: "true false null"
  };
  const KEYWORDS_WITH_LABEL = {
    className: "keyword",
    begin: /\b(break|continue|return|this)\b/,
    starts: { contains: [
      {
        className: "symbol",
        begin: /@\w+/
      }
    ] }
  };
  const LABEL = {
    className: "symbol",
    begin: hljs.UNDERSCORE_IDENT_RE + "@"
  };
  const SUBST = {
    className: "subst",
    begin: /\$\{/,
    end: /\}/,
    contains: [hljs.C_NUMBER_MODE]
  };
  const VARIABLE = {
    className: "variable",
    begin: "\\$" + hljs.UNDERSCORE_IDENT_RE
  };
  const STRING = {
    className: "string",
    variants: [
      {
        begin: '"""',
        end: '"""(?=[^"])',
        contains: [
          VARIABLE,
          SUBST
        ]
      },
      // Can't use built-in modes easily, as we want to use STRING in the meta
      // context as 'meta-string' and there's no syntax to remove explicitly set
      // classNames in built-in modes.
      {
        begin: "'",
        end: "'",
        illegal: /\n/,
        contains: [hljs.BACKSLASH_ESCAPE]
      },
      {
        begin: '"',
        end: '"',
        illegal: /\n/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          VARIABLE,
          SUBST
        ]
      }
    ]
  };
  SUBST.contains.push(STRING);
  const ANNOTATION_USE_SITE = {
    className: "meta",
    begin: "@(?:file|property|field|get|set|receiver|param|setparam|delegate)\\s*:(?:\\s*" + hljs.UNDERSCORE_IDENT_RE + ")?"
  };
  const ANNOTATION = {
    className: "meta",
    begin: "@" + hljs.UNDERSCORE_IDENT_RE,
    contains: [
      {
        begin: /\(/,
        end: /\)/,
        contains: [
          hljs.inherit(STRING, { className: "string" }),
          "self"
        ]
      }
    ]
  };
  const KOTLIN_NUMBER_MODE = NUMERIC2;
  const KOTLIN_NESTED_COMMENT = hljs.COMMENT(
    "/\\*",
    "\\*/",
    { contains: [hljs.C_BLOCK_COMMENT_MODE] }
  );
  const KOTLIN_PAREN_TYPE = { variants: [
    {
      className: "type",
      begin: hljs.UNDERSCORE_IDENT_RE
    },
    {
      begin: /\(/,
      end: /\)/,
      contains: []
      // defined later
    }
  ] };
  const KOTLIN_PAREN_TYPE2 = KOTLIN_PAREN_TYPE;
  KOTLIN_PAREN_TYPE2.variants[1].contains = [KOTLIN_PAREN_TYPE];
  KOTLIN_PAREN_TYPE.variants[1].contains = [KOTLIN_PAREN_TYPE2];
  return {
    name: "Kotlin",
    aliases: [
      "kt",
      "kts",
      "ktm",
      "ktx"
    ],
    keywords: KEYWORDS3,
    contains: [
      hljs.COMMENT(
        "/\\*\\*",
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+"
            }
          ]
        }
      ),
      hljs.C_LINE_COMMENT_MODE,
      KOTLIN_NESTED_COMMENT,
      KEYWORDS_WITH_LABEL,
      LABEL,
      ANNOTATION_USE_SITE,
      ANNOTATION,
      {
        className: "function",
        beginKeywords: "fun",
        end: "[(]|$",
        returnBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS3,
        relevance: 5,
        contains: [
          {
            begin: hljs.UNDERSCORE_IDENT_RE + "\\s*\\(",
            returnBegin: true,
            relevance: 0,
            contains: [hljs.UNDERSCORE_TITLE_MODE]
          },
          {
            className: "type",
            begin: /</,
            end: />/,
            keywords: "reified",
            relevance: 0
          },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            endsParent: true,
            keywords: KEYWORDS3,
            relevance: 0,
            contains: [
              {
                begin: /:/,
                end: /[=,\/]/,
                endsWithParent: true,
                contains: [
                  KOTLIN_PAREN_TYPE,
                  hljs.C_LINE_COMMENT_MODE,
                  KOTLIN_NESTED_COMMENT
                ],
                relevance: 0
              },
              hljs.C_LINE_COMMENT_MODE,
              KOTLIN_NESTED_COMMENT,
              ANNOTATION_USE_SITE,
              ANNOTATION,
              STRING,
              hljs.C_NUMBER_MODE
            ]
          },
          KOTLIN_NESTED_COMMENT
        ]
      },
      {
        begin: [
          /class|interface|trait/,
          /\s+/,
          hljs.UNDERSCORE_IDENT_RE
        ],
        beginScope: {
          3: "title.class"
        },
        keywords: "class interface trait",
        end: /[:\{(]|$/,
        excludeEnd: true,
        illegal: "extends implements",
        contains: [
          { beginKeywords: "public protected internal private constructor" },
          hljs.UNDERSCORE_TITLE_MODE,
          {
            className: "type",
            begin: /</,
            end: />/,
            excludeBegin: true,
            excludeEnd: true,
            relevance: 0
          },
          {
            className: "type",
            begin: /[,:]\s*/,
            end: /[<\(,){\s]|$/,
            excludeBegin: true,
            returnEnd: true
          },
          ANNOTATION_USE_SITE,
          ANNOTATION
        ]
      },
      STRING,
      {
        className: "meta",
        begin: "^#!/usr/bin/env",
        end: "$",
        illegal: "\n"
      },
      KOTLIN_NUMBER_MODE
    ]
  };
}

// node_modules/highlight.js/es/languages/less.js
var MODES2 = (hljs) => {
  return {
    IMPORTANT: {
      scope: "meta",
      begin: "!important"
    },
    BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
    HEXCOLOR: {
      scope: "number",
      begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
    },
    UNICODE_RANGE: {
      scope: "number",
      begin: /\b[Uu]\+[0-9A-Fa-f][0-9A-Fa-f?]{0,5}(-[0-9A-Fa-f][0-9A-Fa-f]{0,5})?/
    },
    FUNCTION_DISPATCH: {
      className: "built_in",
      begin: /[\w-]+(?=\()/
    },
    ATTRIBUTE_SELECTOR_MODE: {
      scope: "selector-attr",
      begin: /\[/,
      end: /\]/,
      illegal: "$",
      contains: [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ]
    },
    CSS_NUMBER_MODE: {
      scope: "number",
      begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
      relevance: 0
    },
    CSS_VARIABLE: {
      className: "attr",
      begin: /--[A-Za-z_][A-Za-z0-9_-]*/
    }
  };
};
var HTML_TAGS2 = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
  "body",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "object",
  "ol",
  "optgroup",
  "option",
  "p",
  "picture",
  "q",
  "quote",
  "samp",
  "section",
  "select",
  "source",
  "span",
  "strong",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
  "var",
  "video"
];
var SVG_TAGS2 = [
  "defs",
  "g",
  "marker",
  "mask",
  "pattern",
  "svg",
  "switch",
  "symbol",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feFlood",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feTile",
  "feTurbulence",
  "linearGradient",
  "radialGradient",
  "stop",
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
  "textPath",
  "tspan",
  "foreignObject",
  "clipPath"
];
var TAGS2 = [
  ...HTML_TAGS2,
  ...SVG_TAGS2
];
var MEDIA_FEATURES2 = [
  "any-hover",
  "any-pointer",
  "aspect-ratio",
  "color",
  "color-gamut",
  "color-index",
  "device-aspect-ratio",
  "device-height",
  "device-width",
  "display-mode",
  "forced-colors",
  "grid",
  "height",
  "hover",
  "inverted-colors",
  "monochrome",
  "orientation",
  "overflow-block",
  "overflow-inline",
  "pointer",
  "prefers-color-scheme",
  "prefers-contrast",
  "prefers-reduced-motion",
  "prefers-reduced-transparency",
  "resolution",
  "scan",
  "scripting",
  "update",
  "width",
  // TODO: find a better solution?
  "min-width",
  "max-width",
  "min-height",
  "max-height"
].sort().reverse();
var PSEUDO_CLASSES2 = [
  "active",
  "any-link",
  "blank",
  "checked",
  "current",
  "default",
  "defined",
  "dir",
  // dir()
  "disabled",
  "drop",
  "empty",
  "enabled",
  "first",
  "first-child",
  "first-of-type",
  "fullscreen",
  "future",
  "focus",
  "focus-visible",
  "focus-within",
  "has",
  // has()
  "host",
  // host or host()
  "host-context",
  // host-context()
  "hover",
  "indeterminate",
  "in-range",
  "invalid",
  "is",
  // is()
  "lang",
  // lang()
  "last-child",
  "last-of-type",
  "left",
  "link",
  "local-link",
  "not",
  // not()
  "nth-child",
  // nth-child()
  "nth-col",
  // nth-col()
  "nth-last-child",
  // nth-last-child()
  "nth-last-col",
  // nth-last-col()
  "nth-last-of-type",
  //nth-last-of-type()
  "nth-of-type",
  //nth-of-type()
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "past",
  "placeholder-shown",
  "read-only",
  "read-write",
  "required",
  "right",
  "root",
  "scope",
  "target",
  "target-within",
  "user-invalid",
  "valid",
  "visited",
  "where"
  // where()
].sort().reverse();
var PSEUDO_ELEMENTS2 = [
  "after",
  "backdrop",
  "before",
  "cue",
  "cue-region",
  "first-letter",
  "first-line",
  "grammar-error",
  "marker",
  "part",
  "placeholder",
  "selection",
  "slotted",
  "spelling-error"
].sort().reverse();
var ATTRIBUTES2 = [
  "accent-color",
  "align-content",
  "align-items",
  "align-self",
  "alignment-baseline",
  "all",
  "anchor-name",
  "animation",
  "animation-composition",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-range",
  "animation-range-end",
  "animation-range-start",
  "animation-timeline",
  "animation-timing-function",
  "appearance",
  "aspect-ratio",
  "backdrop-filter",
  "backface-visibility",
  "background",
  "background-attachment",
  "background-blend-mode",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
  "background-position",
  "background-position-x",
  "background-position-y",
  "background-repeat",
  "background-size",
  "baseline-shift",
  "block-size",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-end-color",
  "border-block-end-style",
  "border-block-end-width",
  "border-block-start",
  "border-block-start-color",
  "border-block-start-style",
  "border-block-start-width",
  "border-block-style",
  "border-block-width",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-end-end-radius",
  "border-end-start-radius",
  "border-image",
  "border-image-outset",
  "border-image-repeat",
  "border-image-slice",
  "border-image-source",
  "border-image-width",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-end-color",
  "border-inline-end-style",
  "border-inline-end-width",
  "border-inline-start",
  "border-inline-start-color",
  "border-inline-start-style",
  "border-inline-start-width",
  "border-inline-style",
  "border-inline-width",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-start-end-radius",
  "border-start-start-radius",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-align",
  "box-decoration-break",
  "box-direction",
  "box-flex",
  "box-flex-group",
  "box-lines",
  "box-ordinal-group",
  "box-orient",
  "box-pack",
  "box-shadow",
  "box-sizing",
  "break-after",
  "break-before",
  "break-inside",
  "caption-side",
  "caret-color",
  "clear",
  "clip",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "color-scheme",
  "column-count",
  "column-fill",
  "column-gap",
  "column-rule",
  "column-rule-color",
  "column-rule-style",
  "column-rule-width",
  "column-span",
  "column-width",
  "columns",
  "contain",
  "contain-intrinsic-block-size",
  "contain-intrinsic-height",
  "contain-intrinsic-inline-size",
  "contain-intrinsic-size",
  "contain-intrinsic-width",
  "container",
  "container-name",
  "container-type",
  "content",
  "content-visibility",
  "corner-bottom-left-shape",
  "corner-bottom-right-shape",
  "corner-shape",
  "corner-top-left-shape",
  "corner-top-right-shape",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "cue",
  "cue-after",
  "cue-before",
  "cursor",
  "cx",
  "cy",
  "direction",
  "display",
  "dominant-baseline",
  "empty-cells",
  "enable-background",
  "field-sizing",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "float",
  "flood-color",
  "flood-opacity",
  "flow",
  "font",
  "font-display",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-smooth",
  "font-smoothing",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-synthesis-position",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "forced-color-adjust",
  "gap",
  "glyph-orientation-horizontal",
  "glyph-orientation-vertical",
  "grid",
  "grid-area",
  "grid-auto-columns",
  "grid-auto-flow",
  "grid-auto-rows",
  "grid-column",
  "grid-column-end",
  "grid-column-start",
  "grid-gap",
  "grid-row",
  "grid-row-end",
  "grid-row-start",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "hanging-punctuation",
  "height",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "icon",
  "image-orientation",
  "image-rendering",
  "image-resolution",
  "ime-mode",
  "initial-letter",
  "initial-letter-align",
  "inline-size",
  "inset",
  "inset-area",
  "inset-block",
  "inset-block-end",
  "inset-block-start",
  "inset-inline",
  "inset-inline-end",
  "inset-inline-start",
  "isolation",
  "justify-content",
  "justify-items",
  "justify-self",
  "kerning",
  "left",
  "letter-spacing",
  "lighting-color",
  "line-break",
  "line-height",
  "line-height-step",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-block",
  "margin-block-end",
  "margin-block-start",
  "margin-bottom",
  "margin-inline",
  "margin-inline-end",
  "margin-inline-start",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-trim",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "marks",
  "mask",
  "mask-border",
  "mask-border-mode",
  "mask-border-outset",
  "mask-border-repeat",
  "mask-border-slice",
  "mask-border-source",
  "mask-border-width",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "mask-type",
  "masonry-auto-flow",
  "math-depth",
  "math-shift",
  "math-style",
  "max-block-size",
  "max-height",
  "max-inline-size",
  "max-width",
  "min-block-size",
  "min-height",
  "min-inline-size",
  "min-width",
  "mix-blend-mode",
  "nav-down",
  "nav-index",
  "nav-left",
  "nav-right",
  "nav-up",
  "none",
  "normal",
  "object-fit",
  "object-position",
  "offset",
  "offset-anchor",
  "offset-distance",
  "offset-path",
  "offset-position",
  "offset-rotate",
  "opacity",
  "order",
  "orphans",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow",
  "overflow-anchor",
  "overflow-block",
  "overflow-clip-margin",
  "overflow-inline",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "overlay",
  "overscroll-behavior",
  "overscroll-behavior-block",
  "overscroll-behavior-inline",
  "overscroll-behavior-x",
  "overscroll-behavior-y",
  "padding",
  "padding-block",
  "padding-block-end",
  "padding-block-start",
  "padding-bottom",
  "padding-inline",
  "padding-inline-end",
  "padding-inline-start",
  "padding-left",
  "padding-right",
  "padding-top",
  "page",
  "page-break-after",
  "page-break-before",
  "page-break-inside",
  "paint-order",
  "pause",
  "pause-after",
  "pause-before",
  "perspective",
  "perspective-origin",
  "place-content",
  "place-items",
  "place-self",
  "pointer-events",
  "position",
  "position-anchor",
  "position-visibility",
  "print-color-adjust",
  "quotes",
  "r",
  "resize",
  "rest",
  "rest-after",
  "rest-before",
  "right",
  "rotate",
  "row-gap",
  "ruby-align",
  "ruby-position",
  "scale",
  "scroll-behavior",
  "scroll-margin",
  "scroll-margin-block",
  "scroll-margin-block-end",
  "scroll-margin-block-start",
  "scroll-margin-bottom",
  "scroll-margin-inline",
  "scroll-margin-inline-end",
  "scroll-margin-inline-start",
  "scroll-margin-left",
  "scroll-margin-right",
  "scroll-margin-top",
  "scroll-padding",
  "scroll-padding-block",
  "scroll-padding-block-end",
  "scroll-padding-block-start",
  "scroll-padding-bottom",
  "scroll-padding-inline",
  "scroll-padding-inline-end",
  "scroll-padding-inline-start",
  "scroll-padding-left",
  "scroll-padding-right",
  "scroll-padding-top",
  "scroll-snap-align",
  "scroll-snap-stop",
  "scroll-snap-type",
  "scroll-timeline",
  "scroll-timeline-axis",
  "scroll-timeline-name",
  "scrollbar-color",
  "scrollbar-gutter",
  "scrollbar-width",
  "shape-image-threshold",
  "shape-margin",
  "shape-outside",
  "shape-rendering",
  "speak",
  "speak-as",
  "src",
  // @font-face
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "table-layout",
  "text-align",
  "text-align-all",
  "text-align-last",
  "text-anchor",
  "text-combine-upright",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-skip",
  "text-decoration-skip-ink",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-emphasis",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-justify",
  "text-orientation",
  "text-overflow",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "timeline-scope",
  "top",
  "touch-action",
  "transform",
  "transform-box",
  "transform-origin",
  "transform-style",
  "transition",
  "transition-behavior",
  "transition-delay",
  "transition-duration",
  "transition-property",
  "transition-timing-function",
  "translate",
  "unicode-bidi",
  "unicode-range",
  "user-modify",
  "user-select",
  "vector-effect",
  "vertical-align",
  "view-timeline",
  "view-timeline-axis",
  "view-timeline-inset",
  "view-timeline-name",
  "view-transition-name",
  "visibility",
  "voice-balance",
  "voice-duration",
  "voice-family",
  "voice-pitch",
  "voice-range",
  "voice-rate",
  "voice-stress",
  "voice-volume",
  "white-space",
  "white-space-collapse",
  "widows",
  "width",
  "will-change",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "x",
  "y",
  "z-index",
  "zoom"
].sort().reverse();
var PSEUDO_SELECTORS = PSEUDO_CLASSES2.concat(PSEUDO_ELEMENTS2).sort().reverse();
function less(hljs) {
  const modes = MODES2(hljs);
  const PSEUDO_SELECTORS$1 = PSEUDO_SELECTORS;
  const AT_MODIFIERS = "and or not only";
  const IDENT_RE3 = "[\\w-]+";
  const INTERP_IDENT_RE = "(" + IDENT_RE3 + "|@\\{" + IDENT_RE3 + "\\})";
  const RULES = [];
  const VALUE_MODES = [];
  const STRING_MODE = function(c2) {
    return {
      // Less strings are not multiline (also include '~' for more consistent coloring of "escaped" strings)
      className: "string",
      begin: "~?" + c2 + ".*?" + c2
    };
  };
  const IDENT_MODE = function(name, begin, relevance) {
    return {
      className: name,
      begin,
      relevance
    };
  };
  const AT_KEYWORDS = {
    $pattern: /[a-z-]+/,
    keyword: AT_MODIFIERS,
    attribute: MEDIA_FEATURES2.join(" ")
  };
  const PARENS_MODE = {
    // used only to properly balance nested parens inside mixin call, def. arg list
    begin: "\\(",
    end: "\\)",
    contains: VALUE_MODES,
    keywords: AT_KEYWORDS,
    relevance: 0
  };
  VALUE_MODES.push(
    hljs.C_LINE_COMMENT_MODE,
    hljs.C_BLOCK_COMMENT_MODE,
    STRING_MODE("'"),
    STRING_MODE('"'),
    modes.CSS_NUMBER_MODE,
    // fixme: it does not include dot for numbers like .5em :(
    {
      begin: "(url|data-uri)\\(",
      starts: {
        className: "string",
        end: "[\\)\\n]",
        excludeEnd: true
      }
    },
    modes.UNICODE_RANGE,
    modes.HEXCOLOR,
    PARENS_MODE,
    IDENT_MODE("variable", "@@?" + IDENT_RE3, 10),
    IDENT_MODE("variable", "@\\{" + IDENT_RE3 + "\\}"),
    IDENT_MODE("built_in", "~?`[^`]*?`"),
    // inline javascript (or whatever host language) *multiline* string
    {
      // @media features (it’s here to not duplicate things in AT_RULE_MODE with extra PARENS_MODE overriding):
      className: "attribute",
      begin: IDENT_RE3 + "\\s*:",
      end: ":",
      returnBegin: true,
      excludeEnd: true
    },
    modes.IMPORTANT,
    { beginKeywords: "and not" },
    modes.FUNCTION_DISPATCH
  );
  const VALUE_WITH_RULESETS = VALUE_MODES.concat({
    begin: /\{/,
    end: /\}/,
    contains: RULES
  });
  const MIXIN_GUARD_MODE = {
    beginKeywords: "when",
    endsWithParent: true,
    contains: [{ beginKeywords: "and not" }].concat(VALUE_MODES)
    // using this form to override VALUE’s 'function' match
  };
  const RULE_MODE = {
    begin: INTERP_IDENT_RE + "\\s*:",
    returnBegin: true,
    end: /[;}]/,
    relevance: 0,
    contains: [
      { begin: /-(webkit|moz|ms|o)-/ },
      modes.CSS_VARIABLE,
      {
        className: "attribute",
        begin: "\\b(" + ATTRIBUTES2.join("|") + ")\\b",
        end: /(?=:)/,
        starts: {
          endsWithParent: true,
          illegal: "[<=$]",
          relevance: 0,
          contains: VALUE_MODES
        }
      }
    ]
  };
  const AT_RULE_MODE = {
    className: "keyword",
    begin: "@(import|media|charset|font-face|(-[a-z]+-)?keyframes|supports|document|namespace|page|viewport|host)\\b",
    starts: {
      end: "[;{}]",
      keywords: AT_KEYWORDS,
      returnEnd: true,
      contains: VALUE_MODES,
      relevance: 0
    }
  };
  const VAR_RULE_MODE = {
    className: "variable",
    variants: [
      // using more strict pattern for higher relevance to increase chances of Less detection.
      // this is *the only* Less specific statement used in most of the sources, so...
      // (we’ll still often loose to the css-parser unless there's '//' comment,
      // simply because 1 variable just can't beat 99 properties :)
      {
        begin: "@" + IDENT_RE3 + "\\s*:",
        relevance: 15
      },
      { begin: "@" + IDENT_RE3 }
    ],
    starts: {
      end: "[;}]",
      returnEnd: true,
      contains: VALUE_WITH_RULESETS
    }
  };
  const SELECTOR_MODE = {
    // first parse unambiguous selectors (i.e. those not starting with tag)
    // then fall into the scary lookahead-discriminator variant.
    // this mode also handles mixin definitions and calls
    variants: [
      {
        begin: "[\\.#:&\\[>]",
        end: "[;{}]"
        // mixin calls end with ';'
      },
      {
        begin: INTERP_IDENT_RE,
        end: /\{/
      }
    ],
    returnBegin: true,
    returnEnd: true,
    illegal: `[<='$"]`,
    relevance: 0,
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      MIXIN_GUARD_MODE,
      IDENT_MODE("keyword", "all\\b"),
      IDENT_MODE("variable", "@\\{" + IDENT_RE3 + "\\}"),
      // otherwise it’s identified as tag
      {
        begin: "\\b(" + TAGS2.join("|") + ")\\b",
        className: "selector-tag"
      },
      modes.CSS_NUMBER_MODE,
      IDENT_MODE("selector-tag", INTERP_IDENT_RE, 0),
      IDENT_MODE("selector-id", "#" + INTERP_IDENT_RE),
      IDENT_MODE("selector-class", "\\." + INTERP_IDENT_RE, 0),
      IDENT_MODE("selector-tag", "&", 0),
      modes.ATTRIBUTE_SELECTOR_MODE,
      {
        className: "selector-pseudo",
        begin: ":(" + PSEUDO_CLASSES2.join("|") + ")"
      },
      {
        className: "selector-pseudo",
        begin: ":(:)?(" + PSEUDO_ELEMENTS2.join("|") + ")"
      },
      {
        begin: /\(/,
        end: /\)/,
        relevance: 0,
        contains: VALUE_WITH_RULESETS
      },
      // argument list of parametric mixins
      { begin: "!important" },
      // eat !important after mixin call or it will be colored as tag
      modes.FUNCTION_DISPATCH
    ]
  };
  const PSEUDO_SELECTOR_MODE = {
    begin: IDENT_RE3 + `:(:)?(${PSEUDO_SELECTORS$1.join("|")})`,
    returnBegin: true,
    contains: [SELECTOR_MODE]
  };
  RULES.push(
    hljs.C_LINE_COMMENT_MODE,
    hljs.C_BLOCK_COMMENT_MODE,
    AT_RULE_MODE,
    VAR_RULE_MODE,
    PSEUDO_SELECTOR_MODE,
    RULE_MODE,
    SELECTOR_MODE,
    MIXIN_GUARD_MODE,
    modes.FUNCTION_DISPATCH
  );
  return {
    name: "Less",
    case_insensitive: true,
    illegal: `[=>'/<($"]`,
    contains: RULES
  };
}

// node_modules/highlight.js/es/languages/lua.js
function lua(hljs) {
  const OPENING_LONG_BRACKET = "\\[=*\\[";
  const CLOSING_LONG_BRACKET = "\\]=*\\]";
  const LONG_BRACKETS = {
    begin: OPENING_LONG_BRACKET,
    end: CLOSING_LONG_BRACKET,
    contains: ["self"]
  };
  const COMMENTS = [
    hljs.COMMENT("--(?!" + OPENING_LONG_BRACKET + ")", "$"),
    hljs.COMMENT(
      "--" + OPENING_LONG_BRACKET,
      CLOSING_LONG_BRACKET,
      {
        contains: [LONG_BRACKETS],
        relevance: 10
      }
    )
  ];
  return {
    name: "Lua",
    aliases: ["pluto"],
    keywords: {
      $pattern: hljs.UNDERSCORE_IDENT_RE,
      literal: "true false nil",
      keyword: "and break do else elseif end for goto if in local global not or repeat return then until while",
      built_in: (
        // Metatags and globals:
        "_G _ENV _VERSION __index __newindex __mode __call __metatable __tostring __len __gc __add __sub __mul __div __mod __pow __concat __unm __eq __lt __le assert collectgarbage dofile error getfenv getmetatable ipairs load loadfile loadstring module next pairs pcall print rawequal rawget rawset require select setfenv setmetatable tonumber tostring type unpack xpcall arg self coroutine resume yield status wrap create running debug getupvalue debug sethook getmetatable gethook setmetatable setlocal traceback setfenv getinfo setupvalue getlocal getregistry getfenv io lines write close flush open output type read stderr stdin input stdout popen tmpfile math log max acos huge ldexp pi cos tanh pow deg tan cosh sinh random randomseed frexp ceil floor rad abs sqrt modf asin min mod fmod log10 atan2 exp sin atan os exit setlocale date getenv difftime remove time clock tmpname rename execute package preload loadlib loaded loaders cpath config path seeall string sub upper len gfind rep find match char dump gmatch reverse byte format gsub lower table setn insert getn foreachi maxn foreach concat sort remove"
      )
    },
    contains: COMMENTS.concat([
      {
        className: "function",
        beginKeywords: "function",
        end: "\\)",
        contains: [
          hljs.inherit(hljs.TITLE_MODE, { begin: "([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*" }),
          {
            className: "params",
            begin: "\\(",
            endsWithParent: true,
            contains: COMMENTS
          }
        ].concat(COMMENTS)
      },
      hljs.C_NUMBER_MODE,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      {
        className: "string",
        begin: OPENING_LONG_BRACKET,
        end: CLOSING_LONG_BRACKET,
        contains: [LONG_BRACKETS],
        relevance: 5
      }
    ])
  };
}

// node_modules/highlight.js/es/languages/makefile.js
function makefile(hljs) {
  const VARIABLE = {
    className: "variable",
    variants: [
      {
        begin: "\\$\\(" + hljs.UNDERSCORE_IDENT_RE + "\\)",
        contains: [hljs.BACKSLASH_ESCAPE]
      },
      { begin: /\$[@%<?\^\+\*]/ }
    ]
  };
  const QUOTE_STRING = {
    className: "string",
    begin: /"/,
    end: /"/,
    contains: [
      hljs.BACKSLASH_ESCAPE,
      VARIABLE
    ]
  };
  const FUNC = {
    className: "variable",
    begin: /\$\([\w-]+\s/,
    end: /\)/,
    keywords: { built_in: "subst patsubst strip findstring filter filter-out sort word wordlist firstword lastword dir notdir suffix basename addsuffix addprefix join wildcard realpath abspath error warning shell origin flavor foreach if or and call eval file value" },
    contains: [
      VARIABLE,
      QUOTE_STRING
      // Added QUOTE_STRING as they can be a part of functions
    ]
  };
  const ASSIGNMENT = { begin: "^" + hljs.UNDERSCORE_IDENT_RE + "\\s*(?=[:+?]?=)" };
  const META = {
    className: "meta",
    begin: /^\.PHONY:/,
    end: /$/,
    keywords: {
      $pattern: /[\.\w]+/,
      keyword: ".PHONY"
    }
  };
  const TARGET = {
    className: "section",
    begin: /^[^\s]+:/,
    end: /$/,
    contains: [VARIABLE]
  };
  return {
    name: "Makefile",
    aliases: [
      "mk",
      "mak",
      "make"
    ],
    keywords: {
      $pattern: /[\w-]+/,
      keyword: "define endef undefine ifdef ifndef ifeq ifneq else endif include -include sinclude override export unexport private vpath"
    },
    contains: [
      hljs.HASH_COMMENT_MODE,
      VARIABLE,
      QUOTE_STRING,
      FUNC,
      ASSIGNMENT,
      META,
      TARGET
    ]
  };
}

// node_modules/highlight.js/es/languages/markdown.js
function markdown(hljs) {
  const regex = hljs.regex;
  const INLINE_HTML = {
    begin: /<\/?[A-Za-z_]/,
    end: ">",
    subLanguage: "xml",
    relevance: 0
  };
  const HORIZONTAL_RULE = { match: /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/ };
  const CODE = {
    className: "code",
    variants: [
      // TODO: fix to allow these to work with sublanguage also
      { begin: "(`{3,})[^`](.|\\n)*?\\1`*[ ]*" },
      { begin: "(~{3,})[^~](.|\\n)*?\\1~*[ ]*" },
      // needed to allow markdown as a sublanguage to work
      {
        begin: "```",
        end: "```+[ ]*$"
      },
      {
        begin: "~~~",
        end: "~~~+[ ]*$"
      },
      { begin: "`.+?`" },
      {
        begin: "(?=^( {4}|\\t))",
        // use contains to gobble up multiple lines to allow the block to be whatever size
        // but only have a single open/close tag vs one per line
        contains: [
          {
            begin: "^( {4}|\\t)",
            end: "(\\n)$"
          }
        ],
        relevance: 0
      }
    ]
  };
  const LIST = {
    className: "bullet",
    begin: "^[ 	]*([*+-]|(\\d+\\.))(?=\\s+)",
    end: "\\s+",
    excludeEnd: true
  };
  const LINK_REFERENCE = {
    begin: /^\[[^\n]+\]:/,
    returnBegin: true,
    contains: [
      {
        className: "symbol",
        begin: /\[/,
        end: /\]/,
        excludeBegin: true,
        excludeEnd: true
      },
      {
        className: "link",
        begin: /:\s*/,
        end: /$/,
        excludeBegin: true
      }
    ]
  };
  const URL_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*/;
  const LINK = {
    variants: [
      // too much like nested array access in so many languages
      // to have any real relevance
      {
        begin: /\[.+?\]\[.*?\]/,
        relevance: 0
      },
      // popular internet URLs
      {
        begin: /\[.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/).*?\)/,
        relevance: 2
      },
      {
        begin: regex.concat(/\[.+?\]\(/, URL_SCHEME, /:\/\/.*?\)/),
        relevance: 2
      },
      // relative urls
      {
        begin: /\[.+?\]\([./?&#].*?\)/,
        relevance: 1
      },
      // whatever else, lower relevance (might not be a link at all)
      {
        begin: /\[.*?\]\(.*?\)/,
        relevance: 0
      }
    ],
    returnBegin: true,
    contains: [
      {
        // empty strings for alt or link text
        match: /\[(?=\])/
      },
      {
        className: "string",
        relevance: 0,
        begin: "\\[",
        end: "\\]",
        excludeBegin: true,
        returnEnd: true
      },
      {
        className: "link",
        relevance: 0,
        begin: "\\]\\(",
        end: "\\)",
        excludeBegin: true,
        excludeEnd: true
      },
      {
        className: "symbol",
        relevance: 0,
        begin: "\\]\\[",
        end: "\\]",
        excludeBegin: true,
        excludeEnd: true
      }
    ]
  };
  const BOLD = {
    className: "strong",
    contains: [],
    // defined later
    variants: [
      {
        begin: /_{2}(?!\s)/,
        end: /_{2}/
      },
      {
        begin: /\*{2}(?!\s)/,
        end: /\*{2}/
      }
    ]
  };
  const ITALIC = {
    className: "emphasis",
    contains: [],
    // defined later
    variants: [
      {
        begin: /\*(?![*\s])/,
        end: /\*/
      },
      {
        begin: /_(?![_\s])/,
        end: /_/,
        relevance: 0
      }
    ]
  };
  const BOLD_WITHOUT_ITALIC = hljs.inherit(BOLD, { contains: [] });
  const ITALIC_WITHOUT_BOLD = hljs.inherit(ITALIC, { contains: [] });
  BOLD.contains.push(ITALIC_WITHOUT_BOLD);
  ITALIC.contains.push(BOLD_WITHOUT_ITALIC);
  let CONTAINABLE = [
    INLINE_HTML,
    LINK
  ];
  [
    BOLD,
    ITALIC,
    BOLD_WITHOUT_ITALIC,
    ITALIC_WITHOUT_BOLD
  ].forEach((m) => {
    m.contains = m.contains.concat(CONTAINABLE);
  });
  CONTAINABLE = CONTAINABLE.concat(BOLD, ITALIC);
  const HEADER = {
    className: "section",
    variants: [
      {
        begin: "^#{1,6}",
        end: "$",
        contains: CONTAINABLE
      },
      {
        begin: "(?=^.+?\\n[=-]{2,}$)",
        contains: [
          { begin: "^[=-]*$" },
          {
            begin: "^",
            end: "\\n",
            contains: CONTAINABLE
          }
        ]
      }
    ]
  };
  const BLOCKQUOTE = {
    className: "quote",
    begin: "^>\\s+",
    contains: CONTAINABLE,
    end: "$"
  };
  const ENTITY = {
    //https://spec.commonmark.org/0.31.2/#entity-references
    scope: "literal",
    match: /&([a-zA-Z0-9]+|#[0-9]{1,7}|#[Xx][0-9a-fA-F]{1,6});/
  };
  return {
    name: "Markdown",
    aliases: [
      "md",
      "mkdown",
      "mkd"
    ],
    contains: [
      HEADER,
      INLINE_HTML,
      LIST,
      // must come before BOLD/ITALIC so that a `***` or `___` thematic break
      // isn't mistaken for the start of bold text
      HORIZONTAL_RULE,
      BOLD,
      ITALIC,
      BLOCKQUOTE,
      CODE,
      LINK,
      LINK_REFERENCE,
      ENTITY
    ]
  };
}

// node_modules/highlight.js/es/languages/nginx.js
function nginx(hljs) {
  const regex = hljs.regex;
  const VAR = {
    className: "variable",
    variants: [
      { begin: /\$\d+/ },
      { begin: /\$\{\w+\}/ },
      { begin: regex.concat(/[$@]/, hljs.UNDERSCORE_IDENT_RE) }
    ]
  };
  const LITERALS3 = [
    "on",
    "off",
    "yes",
    "no",
    "true",
    "false",
    "none",
    "blocked",
    "debug",
    "info",
    "notice",
    "warn",
    "error",
    "crit",
    "select",
    "break",
    "last",
    "permanent",
    "redirect",
    "kqueue",
    "rtsig",
    "epoll",
    "poll",
    "/dev/poll"
  ];
  const DEFAULT = {
    endsWithParent: true,
    keywords: {
      $pattern: /[a-z_]{2,}|\/dev\/poll/,
      literal: LITERALS3
    },
    relevance: 0,
    illegal: "=>",
    contains: [
      hljs.HASH_COMMENT_MODE,
      {
        className: "string",
        contains: [
          hljs.BACKSLASH_ESCAPE,
          VAR
        ],
        variants: [
          {
            begin: /"/,
            end: /"/
          },
          {
            begin: /'/,
            end: /'/
          }
        ]
      },
      // this swallows entire URLs to avoid detecting numbers within
      {
        begin: "([a-z]+):/",
        end: "\\s",
        endsWithParent: true,
        excludeEnd: true,
        contains: [VAR]
      },
      {
        className: "regexp",
        contains: [
          hljs.BACKSLASH_ESCAPE,
          VAR
        ],
        variants: [
          {
            begin: "\\s\\^",
            end: "\\s|\\{|;",
            returnEnd: true
          },
          // regexp locations (~, ~*)
          {
            begin: "~\\*?\\s+",
            end: "\\s|\\{|;",
            returnEnd: true
          },
          // *.example.com
          { begin: "\\*(\\.[a-z\\-]+)+" },
          // sub.example.*
          { begin: "([a-z\\-]+\\.)+\\*" }
        ]
      },
      // IP
      {
        className: "number",
        begin: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(:\\d{1,5})?\\b"
      },
      // units
      {
        className: "number",
        begin: "\\b\\d+[kKmMgGdshdwy]?\\b",
        relevance: 0
      },
      VAR
    ]
  };
  return {
    name: "Nginx config",
    aliases: ["nginxconf"],
    contains: [
      hljs.HASH_COMMENT_MODE,
      {
        beginKeywords: "upstream location",
        end: /;|\{/,
        contains: DEFAULT.contains,
        keywords: { section: "upstream location" }
      },
      {
        className: "section",
        begin: regex.concat(hljs.UNDERSCORE_IDENT_RE + regex.lookahead(/\s+\{/)),
        relevance: 0
      },
      {
        begin: regex.lookahead(hljs.UNDERSCORE_IDENT_RE + "\\s"),
        end: ";|\\{",
        contains: [
          {
            className: "attribute",
            begin: hljs.UNDERSCORE_IDENT_RE,
            starts: DEFAULT
          }
        ],
        relevance: 0
      }
    ],
    illegal: "[^\\s\\}\\{]"
  };
}

// node_modules/highlight.js/es/languages/objectivec.js
function objectivec(hljs) {
  const API_CLASS = {
    className: "built_in",
    begin: "\\b(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)\\w+"
  };
  const IDENTIFIER_RE = /[a-zA-Z@][a-zA-Z0-9_]*/;
  const TYPES3 = [
    "int",
    "float",
    "char",
    "unsigned",
    "signed",
    "short",
    "long",
    "double",
    "wchar_t",
    "unichar",
    "void",
    "bool",
    "BOOL",
    "id|0",
    "_Bool"
  ];
  const KWS = [
    "while",
    "export",
    "sizeof",
    "typedef",
    "const",
    "struct",
    "for",
    "union",
    "volatile",
    "static",
    "mutable",
    "if",
    "do",
    "return",
    "goto",
    "enum",
    "else",
    "break",
    "extern",
    "asm",
    "case",
    "default",
    "register",
    "explicit",
    "typename",
    "switch",
    "continue",
    "inline",
    "readonly",
    "assign",
    "readwrite",
    "self",
    "@synchronized",
    "id",
    "typeof",
    "nonatomic",
    "IBOutlet",
    "IBAction",
    "strong",
    "weak",
    "copy",
    "in",
    "out",
    "inout",
    "bycopy",
    "byref",
    "oneway",
    "__strong",
    "__weak",
    "__block",
    "__autoreleasing",
    "@private",
    "@protected",
    "@public",
    "@try",
    "@property",
    "@end",
    "@throw",
    "@catch",
    "@finally",
    "@autoreleasepool",
    "@synthesize",
    "@dynamic",
    "@selector",
    "@optional",
    "@required",
    "@encode",
    "@package",
    "@import",
    "@defs",
    "@compatibility_alias",
    "__bridge",
    "__bridge_transfer",
    "__bridge_retained",
    "__bridge_retain",
    "__covariant",
    "__contravariant",
    "__kindof",
    "_Nonnull",
    "_Nullable",
    "_Null_unspecified",
    "__FUNCTION__",
    "__PRETTY_FUNCTION__",
    "__attribute__",
    "getter",
    "setter",
    "retain",
    "unsafe_unretained",
    "nonnull",
    "nullable",
    "null_unspecified",
    "null_resettable",
    "class",
    "instancetype",
    "NS_DESIGNATED_INITIALIZER",
    "NS_UNAVAILABLE",
    "NS_REQUIRES_SUPER",
    "NS_RETURNS_INNER_POINTER",
    "NS_INLINE",
    "NS_AVAILABLE",
    "NS_DEPRECATED",
    "NS_ENUM",
    "NS_OPTIONS",
    "NS_SWIFT_UNAVAILABLE",
    "NS_ASSUME_NONNULL_BEGIN",
    "NS_ASSUME_NONNULL_END",
    "NS_REFINED_FOR_SWIFT",
    "NS_SWIFT_NAME",
    "NS_SWIFT_NOTHROW",
    "NS_DURING",
    "NS_HANDLER",
    "NS_ENDHANDLER",
    "NS_VALUERETURN",
    "NS_VOIDRETURN"
  ];
  const LITERALS3 = [
    "false",
    "true",
    "FALSE",
    "TRUE",
    "nil",
    "YES",
    "NO",
    "NULL"
  ];
  const BUILT_INS3 = [
    "dispatch_once_t",
    "dispatch_queue_t",
    "dispatch_sync",
    "dispatch_async",
    "dispatch_once"
  ];
  const KEYWORDS3 = {
    "variable.language": [
      "this",
      "super"
    ],
    $pattern: IDENTIFIER_RE,
    keyword: KWS,
    literal: LITERALS3,
    built_in: BUILT_INS3,
    type: TYPES3
  };
  const CLASS_KEYWORDS = {
    $pattern: IDENTIFIER_RE,
    keyword: [
      "@interface",
      "@class",
      "@protocol",
      "@implementation"
    ]
  };
  return {
    name: "Objective-C",
    aliases: [
      "mm",
      "objc",
      "obj-c",
      "obj-c++",
      "objective-c++"
    ],
    keywords: KEYWORDS3,
    illegal: "</",
    contains: [
      API_CLASS,
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.C_NUMBER_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.APOS_STRING_MODE,
      {
        className: "string",
        variants: [
          {
            begin: '@"',
            end: '"',
            illegal: "\\n",
            contains: [hljs.BACKSLASH_ESCAPE]
          }
        ]
      },
      {
        className: "meta",
        begin: /#\s*[a-z]+\b/,
        end: /$/,
        keywords: { keyword: "if else elif endif define undef warning error line pragma ifdef ifndef include" },
        contains: [
          {
            begin: /\\\n/,
            relevance: 0
          },
          hljs.inherit(hljs.QUOTE_STRING_MODE, { className: "string" }),
          {
            className: "string",
            begin: /<.*?>/,
            end: /$/,
            illegal: "\\n"
          },
          hljs.C_LINE_COMMENT_MODE,
          hljs.C_BLOCK_COMMENT_MODE
        ]
      },
      {
        className: "class",
        begin: "(" + CLASS_KEYWORDS.keyword.join("|") + ")\\b",
        end: /(\{|$)/,
        excludeEnd: true,
        keywords: CLASS_KEYWORDS,
        contains: [hljs.UNDERSCORE_TITLE_MODE]
      },
      {
        begin: "\\." + hljs.UNDERSCORE_IDENT_RE,
        relevance: 0
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/perl.js
function perl(hljs) {
  const regex = hljs.regex;
  const KEYWORDS3 = [
    "abs",
    "accept",
    "alarm",
    "and",
    "atan2",
    "bind",
    "binmode",
    "bless",
    "break",
    "caller",
    "chdir",
    "chmod",
    "chomp",
    "chop",
    "chown",
    "chr",
    "chroot",
    "class",
    "close",
    "closedir",
    "connect",
    "continue",
    "cos",
    "crypt",
    "dbmclose",
    "dbmopen",
    "defined",
    "delete",
    "die",
    "do",
    "dump",
    "each",
    "else",
    "elsif",
    "endgrent",
    "endhostent",
    "endnetent",
    "endprotoent",
    "endpwent",
    "endservent",
    "eof",
    "eval",
    "exec",
    "exists",
    "exit",
    "exp",
    "fcntl",
    "field",
    "fileno",
    "flock",
    "for",
    "foreach",
    "fork",
    "format",
    "formline",
    "getc",
    "getgrent",
    "getgrgid",
    "getgrnam",
    "gethostbyaddr",
    "gethostbyname",
    "gethostent",
    "getlogin",
    "getnetbyaddr",
    "getnetbyname",
    "getnetent",
    "getpeername",
    "getpgrp",
    "getpriority",
    "getprotobyname",
    "getprotobynumber",
    "getprotoent",
    "getpwent",
    "getpwnam",
    "getpwuid",
    "getservbyname",
    "getservbyport",
    "getservent",
    "getsockname",
    "getsockopt",
    "given",
    "glob",
    "gmtime",
    "goto",
    "grep",
    "gt",
    "hex",
    "if",
    "index",
    "int",
    "ioctl",
    "join",
    "keys",
    "kill",
    "last",
    "lc",
    "lcfirst",
    "length",
    "link",
    "listen",
    "local",
    "localtime",
    "log",
    "lstat",
    "lt",
    "ma",
    "map",
    "method",
    "mkdir",
    "msgctl",
    "msgget",
    "msgrcv",
    "msgsnd",
    "my",
    "ne",
    "next",
    "no",
    "not",
    "oct",
    "open",
    "opendir",
    "or",
    "ord",
    "our",
    "pack",
    "package",
    "pipe",
    "pop",
    "pos",
    "print",
    "printf",
    "prototype",
    "push",
    "q|0",
    "qq",
    "quotemeta",
    "qw",
    "qx",
    "rand",
    "read",
    "readdir",
    "readline",
    "readlink",
    "readpipe",
    "recv",
    "redo",
    "ref",
    "rename",
    "require",
    "reset",
    "return",
    "reverse",
    "rewinddir",
    "rindex",
    "rmdir",
    "say",
    "scalar",
    "seek",
    "seekdir",
    "select",
    "semctl",
    "semget",
    "semop",
    "send",
    "setgrent",
    "sethostent",
    "setnetent",
    "setpgrp",
    "setpriority",
    "setprotoent",
    "setpwent",
    "setservent",
    "setsockopt",
    "shift",
    "shmctl",
    "shmget",
    "shmread",
    "shmwrite",
    "shutdown",
    "sin",
    "sleep",
    "socket",
    "socketpair",
    "sort",
    "splice",
    "split",
    "sprintf",
    "sqrt",
    "srand",
    "stat",
    "state",
    "study",
    "sub",
    "substr",
    "symlink",
    "syscall",
    "sysopen",
    "sysread",
    "sysseek",
    "system",
    "syswrite",
    "tell",
    "telldir",
    "tie",
    "tied",
    "time",
    "times",
    "tr",
    "truncate",
    "uc",
    "ucfirst",
    "umask",
    "undef",
    "unless",
    "unlink",
    "unpack",
    "unshift",
    "untie",
    "until",
    "use",
    "utime",
    "values",
    "vec",
    "wait",
    "waitpid",
    "wantarray",
    "warn",
    "when",
    "while",
    "write",
    "x|0",
    "xor",
    "y|0"
  ];
  const REGEX_MODIFIERS = /[dualxmsipngr]{0,12}/;
  const PERL_KEYWORDS = {
    $pattern: /[\w.]+/,
    keyword: KEYWORDS3.join(" ")
  };
  const SUBST = {
    className: "subst",
    begin: "[$@]\\{",
    end: "\\}",
    keywords: PERL_KEYWORDS
  };
  const METHOD = {
    begin: /->\{/,
    end: /\}/
    // contains defined later
  };
  const ATTR = {
    scope: "attr",
    match: /\s+:\s*\w+(\s*\(.*?\))?/
  };
  const VAR = {
    scope: "variable",
    variants: [
      { begin: /\$\d/ },
      {
        begin: regex.concat(
          /[$%@](?!")(\^\w\b|#\w+(::\w+)*|\{\w+\}|\w+(::\w*)*)/,
          // negative look-ahead tries to avoid matching patterns that are not
          // Perl at all like $ident$, @ident@, etc.
          `(?![A-Za-z])(?![@$%])`
        )
      },
      {
        // Only $= is a special Perl variable and one can't declare @= or %=.
        begin: /[$%@](?!")[^\s\w{=]|\$=/,
        relevance: 0
      }
    ],
    contains: [ATTR]
  };
  const NUMBER = {
    className: "number",
    variants: [
      // decimal numbers:
      // include the case where a number starts with a dot (eg. .9), and
      // the leading 0? avoids mixing the first and second match on 0.x cases
      { match: /0?\.[0-9][0-9_]+\b/ },
      // include the special versioned number (eg. v5.38)
      { match: /\bv?(0|[1-9][0-9_]*(\.[0-9_]+)?|[1-9][0-9_]*)\b/ },
      // non-decimal numbers:
      { match: /\b0[0-7][0-7_]*\b/ },
      { match: /\b0x[0-9a-fA-F][0-9a-fA-F_]*\b/ },
      { match: /\b0b[0-1][0-1_]*\b/ }
    ],
    relevance: 0
  };
  const STRING_CONTAINS = [
    hljs.BACKSLASH_ESCAPE,
    SUBST,
    VAR
  ];
  const REGEX_DELIMS = [
    /!/,
    /\//,
    /\|/,
    /\?/,
    /'/,
    /"/,
    // valid but infrequent and weird
    /#/
    // valid but infrequent and weird
  ];
  const PAIRED_DOUBLE_RE = (prefix, open, close = "\\1") => {
    const middle = close === "\\1" ? close : regex.concat(close, open);
    return regex.concat(
      regex.concat("(?:", prefix, ")"),
      open,
      /(?:\\.|[^\\\/])*?/,
      middle,
      /(?:\\.|[^\\\/])*?/,
      close,
      REGEX_MODIFIERS
    );
  };
  const PAIRED_RE = (prefix, open, close) => {
    return regex.concat(
      regex.concat("(?:", prefix, ")"),
      open,
      /(?:\\.|[^\\\/])*?/,
      close,
      REGEX_MODIFIERS
    );
  };
  const PERL_DEFAULT_CONTAINS = [
    VAR,
    hljs.HASH_COMMENT_MODE,
    hljs.COMMENT(
      /^=\w/,
      /=cut/,
      { endsWithParent: true }
    ),
    METHOD,
    {
      className: "string",
      contains: STRING_CONTAINS,
      variants: [
        {
          begin: "q[qwxr]?\\s*\\(",
          end: "\\)",
          relevance: 5
        },
        {
          begin: "q[qwxr]?\\s*\\[",
          end: "\\]",
          relevance: 5
        },
        {
          begin: "q[qwxr]?\\s*\\{",
          end: "\\}",
          relevance: 5
        },
        {
          begin: "q[qwxr]?\\s*\\|",
          end: "\\|",
          relevance: 5
        },
        {
          begin: "q[qwxr]?\\s*<",
          end: ">",
          relevance: 5
        },
        {
          begin: "qw\\s+q",
          end: "q",
          relevance: 5
        },
        {
          begin: "'",
          end: "'",
          contains: [hljs.BACKSLASH_ESCAPE]
        },
        {
          begin: '"',
          end: '"'
        },
        {
          begin: "`",
          end: "`",
          contains: [hljs.BACKSLASH_ESCAPE]
        },
        {
          begin: /\{\w+\}/,
          relevance: 0
        },
        {
          begin: "-?\\w+\\s*=>",
          relevance: 0
        }
      ]
    },
    NUMBER,
    {
      // regexp container
      begin: "(\\/\\/|" + hljs.RE_STARTERS_RE + "|\\b(split|return|print|reverse|grep)\\b)\\s*",
      keywords: "split return print reverse grep",
      relevance: 0,
      contains: [
        hljs.HASH_COMMENT_MODE,
        {
          className: "regexp",
          variants: [
            // allow matching common delimiters
            { begin: PAIRED_DOUBLE_RE("s|tr|y", regex.either(...REGEX_DELIMS, { capture: true })) },
            // and then paired delmis
            { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\(", "\\)") },
            { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\[", "\\]") },
            { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\{", "\\}") }
          ],
          relevance: 2
        },
        {
          className: "regexp",
          variants: [
            {
              // could be a comment in many languages so do not count
              // as relevant
              begin: /(m|qr)\/\//,
              relevance: 0
            },
            // prefix is optional with /regex/
            { begin: PAIRED_RE("(?:m|qr)?", /\//, /\//) },
            // allow matching common delimiters
            { begin: PAIRED_RE("m|qr", regex.either(...REGEX_DELIMS, { capture: true }), /\1/) },
            // allow common paired delmins
            { begin: PAIRED_RE("m|qr", /\(/, /\)/) },
            { begin: PAIRED_RE("m|qr", /\[/, /\]/) },
            { begin: PAIRED_RE("m|qr", /\{/, /\}/) }
          ]
        }
      ]
    },
    {
      className: "function",
      beginKeywords: "sub method",
      end: "(\\s*\\(.*?\\))?[;{]",
      excludeEnd: true,
      relevance: 5,
      contains: [hljs.TITLE_MODE, ATTR]
    },
    {
      className: "class",
      beginKeywords: "class",
      end: "[;{]",
      excludeEnd: true,
      relevance: 5,
      contains: [hljs.TITLE_MODE, ATTR, NUMBER]
    },
    {
      begin: "-\\w\\b",
      relevance: 0
    },
    {
      begin: "^__DATA__$",
      end: "^__END__$",
      subLanguage: "mojolicious",
      contains: [
        {
          begin: "^@@.*",
          end: "$",
          className: "comment"
        }
      ]
    }
  ];
  SUBST.contains = PERL_DEFAULT_CONTAINS;
  METHOD.contains = PERL_DEFAULT_CONTAINS;
  return {
    name: "Perl",
    aliases: [
      "pl",
      "pm"
    ],
    keywords: PERL_KEYWORDS,
    contains: PERL_DEFAULT_CONTAINS
  };
}

// node_modules/highlight.js/es/languages/php.js
function php(hljs) {
  const regex = hljs.regex;
  const NOT_PERL_ETC = /(?![A-Za-z0-9])(?![$])/;
  const IDENT_RE3 = regex.concat(
    /[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*/,
    NOT_PERL_ETC
  );
  const PASCAL_CASE_CLASS_NAME_RE = regex.concat(
    /(\\?[A-Z][a-z0-9_\x7f-\xff]+|\\?[A-Z]+(?=[A-Z][a-z0-9_\x7f-\xff])){1,}/,
    NOT_PERL_ETC
  );
  const UPCASE_NAME_RE = regex.concat(
    /[A-Z]+/,
    NOT_PERL_ETC
  );
  const VARIABLE = {
    scope: "variable",
    match: "\\$+" + IDENT_RE3
  };
  const PREPROCESSOR = {
    scope: "meta",
    variants: [
      { begin: /<\?php/, relevance: 10 },
      // boost for obvious PHP
      { begin: /<\?=/ },
      // less relevant per PSR-1 which says not to use short-tags
      { begin: /<\?/, relevance: 0.1 },
      { begin: /\?>/ }
      // end php tag
    ]
  };
  const SUBST = {
    scope: "subst",
    variants: [
      { begin: /\$\w+/ },
      {
        begin: /\{\$/,
        end: /\}/
      }
    ]
  };
  const SINGLE_QUOTED = hljs.inherit(hljs.APOS_STRING_MODE, { illegal: null });
  const DOUBLE_QUOTED = hljs.inherit(hljs.QUOTE_STRING_MODE, {
    illegal: null,
    contains: hljs.QUOTE_STRING_MODE.contains.concat(SUBST)
  });
  const HEREDOC = {
    begin: /<<<[ \t]*(?:(\w+)|"(\w+)")\n/,
    end: /[ \t]*(\w+)\b/,
    contains: hljs.QUOTE_STRING_MODE.contains.concat(SUBST),
    "on:begin": (m, resp) => {
      resp.data._beginMatch = m[1] || m[2];
    },
    "on:end": (m, resp) => {
      if (resp.data._beginMatch !== m[1]) resp.ignoreMatch();
    }
  };
  const NOWDOC = hljs.END_SAME_AS_BEGIN({
    begin: /<<<[ \t]*'(\w+)'\n/,
    end: /[ \t]*(\w+)\b/
  });
  const WHITESPACE = "[ 	\n]";
  const STRING = {
    scope: "string",
    variants: [
      DOUBLE_QUOTED,
      SINGLE_QUOTED,
      HEREDOC,
      NOWDOC
    ]
  };
  const NUMBER = {
    scope: "number",
    variants: [
      { begin: `\\b0[bB][01]+(?:_[01]+)*\\b` },
      // Binary w/ underscore support
      { begin: `\\b0[oO][0-7]+(?:_[0-7]+)*\\b` },
      // Octals w/ underscore support
      { begin: `\\b0[xX][\\da-fA-F]+(?:_[\\da-fA-F]+)*\\b` },
      // Hex w/ underscore support
      // Decimals w/ underscore support, with optional fragments and scientific exponent (e) suffix.
      { begin: `(?:\\b\\d+(?:_\\d+)*(\\.(?:\\d+(?:_\\d+)*))?|\\B\\.\\d+)(?:[eE][+-]?\\d+)?` }
    ],
    relevance: 0
  };
  const LITERALS3 = [
    "false",
    "null",
    "true"
  ];
  const KWS = [
    // Magic constants:
    // <https://www.php.net/manual/en/language.constants.predefined.php>
    "__CLASS__",
    "__DIR__",
    "__FILE__",
    "__FUNCTION__",
    "__COMPILER_HALT_OFFSET__",
    "__LINE__",
    "__METHOD__",
    "__NAMESPACE__",
    "__TRAIT__",
    // Function that look like language construct or language construct that look like function:
    // List of keywords that may not require parenthesis
    "die",
    "echo",
    "exit",
    "include",
    "include_once",
    "print",
    "require",
    "require_once",
    // These are not language construct (function) but operate on the currently-executing function and can access the current symbol table
    // 'compact extract func_get_arg func_get_args func_num_args get_called_class get_parent_class ' +
    // Other keywords:
    // <https://www.php.net/manual/en/reserved.php>
    // <https://www.php.net/manual/en/language.types.type-juggling.php>
    "array",
    "abstract",
    "and",
    "as",
    "binary",
    "bool",
    "boolean",
    "break",
    "callable",
    "case",
    "catch",
    "class",
    "clone",
    "const",
    "continue",
    "declare",
    "default",
    "do",
    "double",
    "else",
    "elseif",
    "empty",
    "enddeclare",
    "endfor",
    "endforeach",
    "endif",
    "endswitch",
    "endwhile",
    "enum",
    "eval",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "foreach",
    "from",
    "global",
    "goto",
    "if",
    "implements",
    "instanceof",
    "insteadof",
    "int",
    "integer",
    "interface",
    "isset",
    "iterable",
    "list",
    "match|0",
    "mixed",
    "new",
    "never",
    "object",
    "or",
    "private",
    "protected",
    "public",
    "readonly",
    "real",
    "return",
    "string",
    "switch",
    "throw",
    "trait",
    "try",
    "unset",
    "use",
    "var",
    "void",
    "while",
    "xor",
    "yield"
  ];
  const BUILT_INS3 = [
    // Standard PHP library:
    // <https://www.php.net/manual/en/book.spl.php>
    "Error|0",
    "AppendIterator",
    "ArgumentCountError",
    "ArithmeticError",
    "ArrayIterator",
    "ArrayObject",
    "AssertionError",
    "BadFunctionCallException",
    "BadMethodCallException",
    "CachingIterator",
    "CallbackFilterIterator",
    "CompileError",
    "Countable",
    "DirectoryIterator",
    "DivisionByZeroError",
    "DomainException",
    "EmptyIterator",
    "ErrorException",
    "Exception",
    "FilesystemIterator",
    "FilterIterator",
    "GlobIterator",
    "InfiniteIterator",
    "InvalidArgumentException",
    "IteratorIterator",
    "LengthException",
    "LimitIterator",
    "LogicException",
    "MultipleIterator",
    "NoRewindIterator",
    "OutOfBoundsException",
    "OutOfRangeException",
    "OuterIterator",
    "OverflowException",
    "ParentIterator",
    "ParseError",
    "RangeException",
    "RecursiveArrayIterator",
    "RecursiveCachingIterator",
    "RecursiveCallbackFilterIterator",
    "RecursiveDirectoryIterator",
    "RecursiveFilterIterator",
    "RecursiveIterator",
    "RecursiveIteratorIterator",
    "RecursiveRegexIterator",
    "RecursiveTreeIterator",
    "RegexIterator",
    "RuntimeException",
    "SeekableIterator",
    "SplDoublyLinkedList",
    "SplFileInfo",
    "SplFileObject",
    "SplFixedArray",
    "SplHeap",
    "SplMaxHeap",
    "SplMinHeap",
    "SplObjectStorage",
    "SplObserver",
    "SplPriorityQueue",
    "SplQueue",
    "SplStack",
    "SplSubject",
    "SplTempFileObject",
    "TypeError",
    "UnderflowException",
    "UnexpectedValueException",
    "UnhandledMatchError",
    // Reserved interfaces:
    // <https://www.php.net/manual/en/reserved.interfaces.php>
    "ArrayAccess",
    "BackedEnum",
    "Closure",
    "Fiber",
    "Generator",
    "Iterator",
    "IteratorAggregate",
    "Serializable",
    "Stringable",
    "Throwable",
    "Traversable",
    "UnitEnum",
    "WeakReference",
    "WeakMap",
    // Reserved classes:
    // <https://www.php.net/manual/en/reserved.classes.php>
    "Directory",
    "__PHP_Incomplete_Class",
    "parent",
    "php_user_filter",
    "self",
    "static",
    "stdClass"
  ];
  const dualCase = (items) => {
    const result = [];
    items.forEach((item) => {
      result.push(item);
      if (item.toLowerCase() === item) {
        result.push(item.toUpperCase());
      } else {
        result.push(item.toLowerCase());
      }
    });
    return result;
  };
  const KEYWORDS3 = {
    keyword: KWS,
    literal: dualCase(LITERALS3),
    built_in: BUILT_INS3
  };
  const normalizeKeywords = (items) => {
    return items.map((item) => {
      return item.replace(/\|\d+$/, "");
    });
  };
  const CONSTRUCTOR_CALL = { variants: [
    {
      match: [
        /new/,
        regex.concat(WHITESPACE, "+"),
        // to prevent built ins from being confused as the class constructor call
        regex.concat("(?!", normalizeKeywords(BUILT_INS3).join("\\b|"), "\\b)"),
        PASCAL_CASE_CLASS_NAME_RE
      ],
      scope: {
        1: "keyword",
        4: "title.class"
      }
    }
  ] };
  const CONSTANT_REFERENCE = regex.concat(IDENT_RE3, "\\b(?!\\()");
  const LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON = { variants: [
    {
      match: [
        regex.concat(
          /::/,
          regex.lookahead(/(?!class\b)/)
        ),
        CONSTANT_REFERENCE
      ],
      scope: { 2: "variable.constant" }
    },
    {
      match: [
        /::/,
        /class/
      ],
      scope: { 2: "variable.language" }
    },
    {
      match: [
        PASCAL_CASE_CLASS_NAME_RE,
        regex.concat(
          /::/,
          regex.lookahead(/(?!class\b)/)
        ),
        CONSTANT_REFERENCE
      ],
      scope: {
        1: "title.class",
        3: "variable.constant"
      }
    },
    {
      match: [
        PASCAL_CASE_CLASS_NAME_RE,
        regex.concat(
          "::",
          regex.lookahead(/(?!class\b)/)
        )
      ],
      scope: { 1: "title.class" }
    },
    {
      match: [
        PASCAL_CASE_CLASS_NAME_RE,
        /::/,
        /class/
      ],
      scope: {
        1: "title.class",
        3: "variable.language"
      }
    }
  ] };
  const NAMED_ARGUMENT = {
    scope: "attr",
    match: regex.concat(IDENT_RE3, regex.lookahead(":"), regex.lookahead(/(?!::)/))
  };
  const PARAMS_MODE = {
    relevance: 0,
    begin: /\(/,
    end: /\)/,
    keywords: KEYWORDS3,
    contains: [
      NAMED_ARGUMENT,
      VARIABLE,
      LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE,
      hljs.HASH_COMMENT_MODE,
      STRING,
      NUMBER,
      CONSTRUCTOR_CALL
    ]
  };
  const FUNCTION_INVOKE = {
    relevance: 0,
    match: [
      /\b/,
      // to prevent keywords from being confused as the function title
      regex.concat("(?!fn\\b|function\\b|", normalizeKeywords(KWS).join("\\b|"), "|", normalizeKeywords(BUILT_INS3).join("\\b|"), "\\b)"),
      IDENT_RE3,
      regex.concat(WHITESPACE, "*"),
      regex.lookahead(/(?=\()/)
    ],
    scope: { 3: "title.function.invoke" },
    contains: [PARAMS_MODE]
  };
  PARAMS_MODE.contains.push(FUNCTION_INVOKE);
  const ATTRIBUTE_CONTAINS = [
    NAMED_ARGUMENT,
    LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
    hljs.C_BLOCK_COMMENT_MODE,
    hljs.C_LINE_COMMENT_MODE,
    hljs.HASH_COMMENT_MODE,
    STRING,
    NUMBER,
    CONSTRUCTOR_CALL
  ];
  const ATTRIBUTES4 = {
    begin: regex.concat(
      /#\[\s*\\?/,
      regex.either(
        PASCAL_CASE_CLASS_NAME_RE,
        UPCASE_NAME_RE
      )
    ),
    beginScope: "meta",
    end: /]/,
    endScope: "meta",
    keywords: {
      literal: LITERALS3,
      keyword: [
        "new",
        "array"
      ]
    },
    contains: [
      {
        begin: /\[/,
        end: /]/,
        keywords: {
          literal: LITERALS3,
          keyword: [
            "new",
            "array"
          ]
        },
        contains: [
          "self",
          ...ATTRIBUTE_CONTAINS
        ]
      },
      ...ATTRIBUTE_CONTAINS,
      {
        scope: "meta",
        variants: [
          { match: PASCAL_CASE_CLASS_NAME_RE },
          { match: UPCASE_NAME_RE }
        ]
      }
    ]
  };
  return {
    case_insensitive: false,
    keywords: KEYWORDS3,
    contains: [
      ATTRIBUTES4,
      hljs.HASH_COMMENT_MODE,
      hljs.COMMENT("//", "$"),
      hljs.COMMENT(
        "/\\*",
        "\\*/",
        { contains: [
          {
            scope: "doctag",
            match: "@[A-Za-z]+"
          }
        ] }
      ),
      {
        match: /__halt_compiler\(\);/,
        keywords: "__halt_compiler",
        starts: {
          scope: "comment",
          end: hljs.MATCH_NOTHING_RE,
          contains: [
            {
              match: /\?>/,
              scope: "meta",
              endsParent: true
            }
          ]
        }
      },
      PREPROCESSOR,
      {
        scope: "variable.language",
        match: /\$this\b/
      },
      VARIABLE,
      FUNCTION_INVOKE,
      LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
      {
        match: [
          /const/,
          /\s/,
          IDENT_RE3
        ],
        scope: {
          1: "keyword",
          3: "variable.constant"
        }
      },
      CONSTRUCTOR_CALL,
      {
        scope: "function",
        relevance: 0,
        beginKeywords: "fn function",
        end: /[;{]/,
        excludeEnd: true,
        illegal: "[$%\\[]",
        contains: [
          { beginKeywords: "use" },
          hljs.UNDERSCORE_TITLE_MODE,
          {
            begin: "=>",
            // No markup, just a relevance booster
            endsParent: true
          },
          {
            scope: "params",
            begin: "\\(",
            end: "\\)",
            excludeBegin: true,
            excludeEnd: true,
            keywords: KEYWORDS3,
            contains: [
              "self",
              ATTRIBUTES4,
              VARIABLE,
              LEFT_AND_RIGHT_SIDE_OF_DOUBLE_COLON,
              hljs.C_BLOCK_COMMENT_MODE,
              hljs.C_LINE_COMMENT_MODE,
              hljs.HASH_COMMENT_MODE,
              STRING,
              NUMBER
            ]
          }
        ]
      },
      {
        scope: "class",
        variants: [
          {
            beginKeywords: "enum",
            illegal: /[($"]/
          },
          {
            beginKeywords: "class interface trait",
            illegal: /[:($"]/
          }
        ],
        relevance: 0,
        end: /\{/,
        excludeEnd: true,
        contains: [
          { beginKeywords: "extends implements" },
          hljs.UNDERSCORE_TITLE_MODE
        ]
      },
      // both use and namespace still use "old style" rules (vs multi-match)
      // because the namespace name can include `\` and we still want each
      // element to be treated as its own *individual* title
      {
        beginKeywords: "namespace",
        relevance: 0,
        end: ";",
        illegal: /[.']/,
        contains: [hljs.inherit(hljs.UNDERSCORE_TITLE_MODE, { scope: "title.class" })]
      },
      {
        beginKeywords: "use",
        relevance: 0,
        end: ";",
        contains: [
          // TODO: title.function vs title.class
          {
            match: /\b(as|const|function)\b/,
            scope: "keyword"
          },
          // TODO: could be title.class or title.function
          hljs.UNDERSCORE_TITLE_MODE
        ]
      },
      STRING,
      NUMBER
    ]
  };
}

// node_modules/highlight.js/es/languages/plaintext.js
function plaintext(hljs) {
  return {
    name: "Plain text",
    aliases: [
      "text",
      "txt"
    ],
    disableAutodetect: true
  };
}

// node_modules/highlight.js/es/languages/python.js
function python(hljs) {
  const regex = hljs.regex;
  const IDENT_RE3 = /[\p{XID_Start}_]\p{XID_Continue}*/u;
  const RESERVED_WORDS = [
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "case",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "lazy",
    "match",
    "nonlocal|10",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield"
  ];
  const BUILT_INS3 = [
    "__import__",
    "abs",
    "aiter",
    "all",
    "anext",
    "any",
    "ascii",
    "bin",
    "bool",
    "breakpoint",
    "bytearray",
    "bytes",
    "callable",
    "chr",
    "classmethod",
    "compile",
    "complex",
    "delattr",
    "dict",
    "dir",
    "divmod",
    "enumerate",
    "eval",
    "exec",
    "filter",
    "float",
    "format",
    "frozendict",
    "frozenset",
    "getattr",
    "globals",
    "hasattr",
    "hash",
    "help",
    "hex",
    "id",
    "input",
    "int",
    "isinstance",
    "issubclass",
    "iter",
    "len",
    "list",
    "locals",
    "map",
    "max",
    "memoryview",
    "min",
    "next",
    "object",
    "oct",
    "open",
    "ord",
    "pow",
    "print",
    "property",
    "range",
    "repr",
    "reversed",
    "round",
    "sentinel",
    "set",
    "setattr",
    "slice",
    "sorted",
    "staticmethod",
    "str",
    "sum",
    "super",
    "tuple",
    "type",
    "vars",
    "zip"
  ];
  const LITERALS3 = [
    "__debug__",
    "Ellipsis",
    "False",
    "None",
    "NotImplemented",
    "True"
  ];
  const TYPES3 = [
    "Any",
    "Callable",
    "Coroutine",
    "Dict",
    "List",
    "Literal",
    "Generic",
    "Optional",
    "Sequence",
    "Set",
    "Tuple",
    "Type",
    "Union"
  ];
  const KEYWORDS3 = {
    $pattern: /[A-Za-z]\w+|__\w+__/,
    keyword: RESERVED_WORDS,
    built_in: BUILT_INS3,
    literal: LITERALS3,
    type: TYPES3
  };
  const PROMPT = {
    className: "meta",
    begin: /^(>>>|\.\.\.) /
  };
  const SUBST = {
    className: "subst",
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS3,
    illegal: /#/
  };
  const LITERAL_BRACKET = {
    begin: /\{\{/,
    relevance: 0
  };
  const STRING = {
    className: "string",
    contains: [hljs.BACKSLASH_ESCAPE],
    variants: [
      {
        begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/,
        end: /'''/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT
        ],
        relevance: 10
      },
      {
        begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/,
        end: /"""/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT
        ],
        relevance: 10
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])'''/,
        end: /'''/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])"""/,
        end: /"""/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      {
        begin: /([uU]|[rR])'/,
        end: /'/,
        relevance: 10
      },
      {
        begin: /([uU]|[rR])"/,
        end: /"/,
        relevance: 10
      },
      {
        begin: /([bB]|[bB][rR]|[rR][bB])'/,
        end: /'/
      },
      {
        begin: /([bB]|[bB][rR]|[rR][bB])"/,
        end: /"/
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])'/,
        end: /'/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])"/,
        end: /"/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE
    ]
  };
  const digitpart = "[0-9](_?[0-9])*";
  const pointfloat = `(\\b(${digitpart}))?\\.(${digitpart})|\\b(${digitpart})\\.`;
  const lookahead2 = `\\b|${RESERVED_WORDS.join("|")}`;
  const NUMBER = {
    className: "number",
    relevance: 0,
    variants: [
      // exponentfloat, pointfloat
      // https://docs.python.org/3.9/reference/lexical_analysis.html#floating-point-literals
      // optionally imaginary
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      // Note: no leading \b because floats can start with a decimal point
      // and we don't want to mishandle e.g. `fn(.5)`,
      // no trailing \b for pointfloat because it can end with a decimal point
      // and we don't want to mishandle e.g. `0..hex()`; this should be safe
      // because both MUST contain a decimal point and so cannot be confused with
      // the interior part of an identifier
      {
        begin: `(\\b(${digitpart})|(${pointfloat}))[eE][+-]?(${digitpart})[jJ]?(?=${lookahead2})`
      },
      {
        begin: `(${pointfloat})[jJ]?`
      },
      // decinteger, bininteger, octinteger, hexinteger
      // https://docs.python.org/3.9/reference/lexical_analysis.html#integer-literals
      // optionally "long" in Python 2
      // https://docs.python.org/2.7/reference/lexical_analysis.html#integer-and-long-integer-literals
      // decinteger is optionally imaginary
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      {
        begin: `\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?(?=${lookahead2})`
      },
      {
        begin: `\\b0[bB](_?[01])+[lL]?(?=${lookahead2})`
      },
      {
        begin: `\\b0[oO](_?[0-7])+[lL]?(?=${lookahead2})`
      },
      {
        begin: `\\b0[xX](_?[0-9a-fA-F])+[lL]?(?=${lookahead2})`
      },
      // imagnumber (digitpart-based)
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      {
        begin: `\\b(${digitpart})[jJ](?=${lookahead2})`
      }
    ]
  };
  const COMMENT_TYPE = {
    className: "comment",
    begin: regex.lookahead(/# type:/),
    end: /$/,
    keywords: KEYWORDS3,
    contains: [
      {
        // prevent keywords from coloring `type`
        begin: /# type:/
      },
      // comment within a datatype comment includes no keywords
      {
        begin: /#/,
        end: /\b\B/,
        endsWithParent: true
      }
    ]
  };
  const PARAMS = {
    className: "params",
    variants: [
      // Exclude params in functions without params
      {
        className: "",
        begin: /\(\s*\)/,
        skip: true
      },
      {
        begin: /\(/,
        end: /\)/,
        excludeBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS3,
        contains: [
          "self",
          PROMPT,
          NUMBER,
          STRING,
          hljs.HASH_COMMENT_MODE
        ]
      }
    ]
  };
  SUBST.contains = [
    STRING,
    NUMBER,
    PROMPT
  ];
  return {
    name: "Python",
    aliases: [
      "py",
      "gyp",
      "ipython"
    ],
    unicodeRegex: true,
    keywords: KEYWORDS3,
    illegal: /(<\/|\?)|=>/,
    contains: [
      PROMPT,
      NUMBER,
      {
        // very common convention
        scope: "variable.language",
        match: /\bself\b/
      },
      {
        // eat "if" prior to string so that it won't accidentally be
        // labeled as an f-string
        beginKeywords: "if",
        relevance: 0
      },
      { match: /\bor\b/, scope: "keyword" },
      STRING,
      COMMENT_TYPE,
      hljs.HASH_COMMENT_MODE,
      {
        match: [
          /\bdef/,
          /\s+/,
          IDENT_RE3
        ],
        scope: {
          1: "keyword",
          3: "title.function"
        },
        contains: [PARAMS]
      },
      {
        variants: [
          {
            match: [
              /\bclass/,
              /\s+/,
              IDENT_RE3,
              /\s*/,
              /\(\s*/,
              IDENT_RE3,
              /\s*\)/
            ]
          },
          {
            match: [
              /\bclass/,
              /\s+/,
              IDENT_RE3
            ]
          }
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          6: "title.class.inherited"
        }
      },
      {
        className: "meta",
        begin: /^[\t ]*@/,
        end: /(?=#)|$/,
        contains: [
          NUMBER,
          PARAMS,
          STRING
        ]
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/ruby.js
function ruby(hljs) {
  const regex = hljs.regex;
  const RUBY_METHOD_RE = "([a-zA-Z_]\\w*[!?=]?|[-+~]@|<<|>>|=~|===?|<=>|[<>]=?|\\*\\*|[-/+%^&*~`|]|\\[\\]=?)";
  const CLASS_NAME_RE = regex.either(
    /\b([A-Z]+[a-z0-9]+)+/,
    // ends in caps
    /\b([A-Z]+[a-z0-9]+)+[A-Z]+/
  );
  const CLASS_NAME_WITH_NAMESPACE_RE = regex.concat(CLASS_NAME_RE, /(::\w+)*/);
  const PSEUDO_KWS = [
    "include",
    "extend",
    "prepend",
    "public",
    "private",
    "protected",
    "raise",
    "throw"
  ];
  const RUBY_KEYWORDS = {
    "variable.constant": [
      "__FILE__",
      "__LINE__",
      "__ENCODING__"
    ],
    "variable.language": [
      "self",
      "super"
    ],
    keyword: [
      "alias",
      "and",
      "begin",
      "BEGIN",
      "break",
      "case",
      "class",
      "defined",
      "do",
      "else",
      "elsif",
      "end",
      "END",
      "ensure",
      "for",
      "if",
      "in",
      "module",
      "next",
      "not",
      "or",
      "redo",
      "require",
      "rescue",
      "retry",
      "return",
      "then",
      "undef",
      "unless",
      "until",
      "when",
      "while",
      "yield",
      ...PSEUDO_KWS
    ],
    built_in: [
      "proc",
      "lambda",
      "attr_accessor",
      "attr_reader",
      "attr_writer",
      "define_method",
      "private_constant",
      "module_function"
    ],
    literal: [
      "true",
      "false",
      "nil"
    ]
  };
  const YARDOCTAG = {
    className: "doctag",
    begin: "@[A-Za-z]+"
  };
  const IRB_OBJECT = {
    begin: "#<",
    end: ">"
  };
  const COMMENT_MODES = [
    hljs.COMMENT(
      "#",
      "$",
      { contains: [YARDOCTAG] }
    ),
    hljs.COMMENT(
      "^=begin",
      "^=end",
      {
        contains: [YARDOCTAG],
        relevance: 10
      }
    ),
    hljs.COMMENT("^__END__", hljs.MATCH_NOTHING_RE)
  ];
  const SUBST = {
    className: "subst",
    begin: /#\{/,
    end: /\}/,
    keywords: RUBY_KEYWORDS
  };
  const STRING = {
    className: "string",
    contains: [
      hljs.BACKSLASH_ESCAPE,
      SUBST
    ],
    variants: [
      {
        begin: /'/,
        end: /'/
      },
      {
        begin: /"/,
        end: /"/
      },
      {
        begin: /`/,
        end: /`/
      },
      {
        begin: /%[qQwWx]?\(/,
        end: /\)/
      },
      {
        begin: /%[qQwWx]?\[/,
        end: /\]/
      },
      {
        begin: /%[qQwWx]?\{/,
        end: /\}/
      },
      {
        begin: /%[qQwWx]?</,
        end: />/
      },
      {
        begin: /%[qQwWx]?\//,
        end: /\//
      },
      {
        begin: /%[qQwWx]?%/,
        end: /%/
      },
      {
        begin: /%[qQwWx]?-/,
        end: /-/
      },
      {
        begin: /%[qQwWx]?\|/,
        end: /\|/
      },
      // in the following expressions, \B in the beginning suppresses recognition of ?-sequences
      // where ? is the last character of a preceding identifier, as in: `func?4`
      { begin: /\B\?(\\\d{1,3})/ },
      { begin: /\B\?(\\x[A-Fa-f0-9]{1,2})/ },
      { begin: /\B\?(\\u\{?[A-Fa-f0-9]{1,6}\}?)/ },
      { begin: /\B\?(\\M-\\C-|\\M-\\c|\\c\\M-|\\M-|\\C-\\M-)[\x20-\x7e]/ },
      { begin: /\B\?\\(c|C-)[\x20-\x7e]/ },
      { begin: /\B\?\\?\S/ },
      // heredocs
      {
        // this guard makes sure that we have an entire heredoc and not a false
        // positive (auto-detect, etc.)
        begin: regex.concat(
          /<<[-~]?'?/,
          regex.lookahead(/(\w+)(?=\W)[^\n]*\n(?:[^\n]*\n)*?\s*\1\b/)
        ),
        contains: [
          hljs.END_SAME_AS_BEGIN({
            begin: /(\w+)/,
            end: /(\w+)/,
            contains: [
              hljs.BACKSLASH_ESCAPE,
              SUBST
            ]
          })
        ]
      }
    ]
  };
  const decimal = "[1-9](_?[0-9])*|0";
  const digits = "[0-9](_?[0-9])*";
  const NUMBER = {
    className: "number",
    relevance: 0,
    variants: [
      // decimal integer/float, optionally exponential or rational, optionally imaginary
      { begin: `\\b(${decimal})(\\.(${digits}))?([eE][+-]?(${digits})|r)?i?\\b` },
      // explicit decimal/binary/octal/hexadecimal integer,
      // optionally rational and/or imaginary
      { begin: "\\b0[dD][0-9](_?[0-9])*r?i?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*r?i?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*r?i?\\b" },
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*r?i?\\b" },
      // 0-prefixed implicit octal integer, optionally rational and/or imaginary
      { begin: "\\b0(_?[0-7])+r?i?\\b" }
    ]
  };
  const PARAMS = {
    variants: [
      {
        match: /\(\)/
      },
      {
        className: "params",
        begin: /\(/,
        end: /(?=\))/,
        excludeBegin: true,
        endsParent: true,
        keywords: RUBY_KEYWORDS
      }
    ]
  };
  const INCLUDE_EXTEND = {
    match: [
      /(include|extend)\s+/,
      CLASS_NAME_WITH_NAMESPACE_RE
    ],
    scope: {
      2: "title.class"
    },
    keywords: RUBY_KEYWORDS
  };
  const CLASS_DEFINITION = {
    variants: [
      {
        match: [
          /class\s+/,
          CLASS_NAME_WITH_NAMESPACE_RE,
          /\s+<\s+/,
          CLASS_NAME_WITH_NAMESPACE_RE
        ]
      },
      {
        match: [
          /\b(class|module)\s+/,
          CLASS_NAME_WITH_NAMESPACE_RE
        ]
      }
    ],
    scope: {
      2: "title.class",
      4: "title.class.inherited"
    },
    keywords: RUBY_KEYWORDS
  };
  const UPPER_CASE_CONSTANT = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  const METHOD_DEFINITION = {
    match: [
      /def/,
      /\s+/,
      RUBY_METHOD_RE
    ],
    scope: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      PARAMS
    ]
  };
  const OBJECT_CREATION = {
    relevance: 0,
    match: [
      CLASS_NAME_WITH_NAMESPACE_RE,
      /\.new[. (]/
    ],
    scope: {
      1: "title.class"
    }
  };
  const CLASS_REFERENCE = {
    relevance: 0,
    match: CLASS_NAME_RE,
    scope: "title.class"
  };
  const RUBY_DEFAULT_CONTAINS = [
    STRING,
    CLASS_DEFINITION,
    INCLUDE_EXTEND,
    OBJECT_CREATION,
    UPPER_CASE_CONSTANT,
    CLASS_REFERENCE,
    METHOD_DEFINITION,
    {
      // swallow the scope resolution operator so `::` is not read as a symbol
      begin: "::"
    },
    {
      className: "symbol",
      begin: hljs.UNDERSCORE_IDENT_RE + "(!|\\?)?:",
      relevance: 0
    },
    {
      className: "symbol",
      begin: ":(?!\\s)",
      contains: [
        STRING,
        { begin: RUBY_METHOD_RE }
      ],
      relevance: 0
    },
    NUMBER,
    {
      // negative-look forward attempts to prevent false matches like:
      // @ident@ or $ident$ that might indicate this is not ruby at all
      className: "variable",
      begin: `(\\$\\W)|((\\$|@@?)(\\w+))(?=[^@$?])(?![A-Za-z])(?![@$?'])`
    },
    {
      className: "params",
      begin: /\|(?!=)/,
      end: /\|/,
      excludeBegin: true,
      excludeEnd: true,
      relevance: 0,
      // this could be a lot of things (in other languages) other than params
      keywords: RUBY_KEYWORDS
    },
    {
      // regexp container
      begin: "(" + hljs.RE_STARTERS_RE + "|unless)\\s*",
      keywords: "unless",
      contains: [
        {
          className: "regexp",
          contains: [
            hljs.BACKSLASH_ESCAPE,
            SUBST
          ],
          illegal: /\n/,
          variants: [
            {
              begin: "/",
              end: "/[a-z]*"
            },
            {
              begin: /%r\{/,
              end: /\}[a-z]*/
            },
            {
              begin: "%r\\(",
              end: "\\)[a-z]*"
            },
            {
              begin: "%r!",
              end: "![a-z]*"
            },
            {
              begin: "%r\\[",
              end: "\\][a-z]*"
            }
          ]
        }
      ].concat(IRB_OBJECT, COMMENT_MODES),
      relevance: 0
    }
  ].concat(IRB_OBJECT, COMMENT_MODES);
  SUBST.contains = RUBY_DEFAULT_CONTAINS;
  PARAMS.contains = RUBY_DEFAULT_CONTAINS;
  const SIMPLE_PROMPT = "[>?]>";
  const DEFAULT_PROMPT = "[\\w#]+\\(\\w+\\):\\d+:\\d+[>*]";
  const RVM_PROMPT = "(\\w+-)?\\d+\\.\\d+\\.\\d+(p\\d+)?[^\\d][^>]+>";
  const IRB_DEFAULT = [
    {
      begin: /^\s*=>/,
      starts: {
        end: "$",
        contains: RUBY_DEFAULT_CONTAINS
      }
    },
    {
      className: "meta.prompt",
      begin: "^(" + SIMPLE_PROMPT + "|" + DEFAULT_PROMPT + "|" + RVM_PROMPT + ")(?=[ ])",
      starts: {
        end: "$",
        keywords: RUBY_KEYWORDS,
        contains: RUBY_DEFAULT_CONTAINS
      }
    }
  ];
  COMMENT_MODES.unshift(IRB_OBJECT);
  return {
    name: "Ruby",
    aliases: [
      "rb",
      "gemspec",
      "podspec",
      "thor",
      "irb"
    ],
    keywords: RUBY_KEYWORDS,
    illegal: /\/\*/,
    contains: [hljs.SHEBANG({ binary: "ruby" })].concat(IRB_DEFAULT).concat(COMMENT_MODES).concat(RUBY_DEFAULT_CONTAINS)
  };
}

// node_modules/highlight.js/es/languages/rust.js
function rust(hljs) {
  const regex = hljs.regex;
  const RAW_IDENTIFIER = /(r#)?/;
  const UNDERSCORE_IDENT_RE = regex.concat(RAW_IDENTIFIER, hljs.UNDERSCORE_IDENT_RE);
  const IDENT_RE3 = regex.concat(RAW_IDENTIFIER, hljs.IDENT_RE);
  const FUNCTION_INVOKE = {
    scope: "title.function.invoke",
    relevance: 0,
    begin: regex.concat(
      /\b/,
      /(?!(?:let|for|while|if|else|match)\b)/,
      IDENT_RE3,
      regex.lookahead(/\s*\(/)
    )
  };
  const NUMBER_SUFFIX = "([ui](8|16|32|64|128|size)|f(16|32|64|128))?";
  const KEYWORDS3 = [
    "abstract",
    "as",
    "async",
    "await",
    "become",
    "box",
    "break",
    "const",
    "continue",
    "crate",
    "do",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "final",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "macro",
    "match",
    "mod",
    "move",
    "mut",
    "override",
    "priv",
    "pub",
    "raw",
    "ref",
    "return",
    "self",
    "Self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "try",
    "type",
    "typeof",
    "union",
    "unsafe",
    "unsized",
    "use",
    "virtual",
    "where",
    "while",
    "yield"
  ];
  const LITERALS3 = [
    "true",
    "false",
    "Some",
    "None",
    "Ok",
    "Err"
  ];
  const BUILTINS = [
    // functions
    "drop ",
    // traits
    "Copy",
    "Send",
    "Sized",
    "Sync",
    "Drop",
    "Fn",
    "FnMut",
    "FnOnce",
    "ToOwned",
    "Clone",
    "Debug",
    "PartialEq",
    "PartialOrd",
    "Eq",
    "Ord",
    "AsRef",
    "AsMut",
    "Into",
    "From",
    "Default",
    "Iterator",
    "Extend",
    "IntoIterator",
    "DoubleEndedIterator",
    "ExactSizeIterator",
    "SliceConcatExt",
    "ToString",
    // macros
    "assert!",
    "assert_eq!",
    "bitflags!",
    "bytes!",
    "cfg!",
    "col!",
    "concat!",
    "concat_idents!",
    "debug_assert!",
    "debug_assert_eq!",
    "env!",
    "eprintln!",
    "panic!",
    "file!",
    "format!",
    "format_args!",
    "include_bytes!",
    "include_str!",
    "line!",
    "local_data_key!",
    "module_path!",
    "option_env!",
    "print!",
    "println!",
    "select!",
    "stringify!",
    "try!",
    "unimplemented!",
    "unreachable!",
    "vec!",
    "write!",
    "writeln!",
    "macro_rules!",
    "assert_ne!",
    "debug_assert_ne!"
  ];
  const TYPES3 = [
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "f16",
    "f32",
    "f64",
    "f128",
    "str",
    "char",
    "bool",
    "Box",
    "Option",
    "Result",
    "String",
    "Vec"
  ];
  return {
    name: "Rust",
    aliases: ["rs"],
    keywords: {
      $pattern: hljs.IDENT_RE + "!?",
      type: TYPES3,
      keyword: KEYWORDS3,
      literal: LITERALS3,
      built_in: BUILTINS
    },
    illegal: "</",
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.COMMENT("/\\*", "\\*/", { contains: ["self"] }),
      hljs.inherit(hljs.QUOTE_STRING_MODE, {
        begin: /b?"/,
        illegal: null
      }),
      {
        scope: "symbol",
        // negative lookahead to avoid matching `'`
        begin: /'[a-zA-Z_][a-zA-Z0-9_]*(?!')/
      },
      {
        scope: "string",
        variants: [
          { begin: /b?r(#*)"(.|\n)*?"\1(?!#)/ },
          {
            begin: /b?'/,
            end: /'/,
            contains: [
              {
                scope: "char.escape",
                match: /\\('|"|\\|\w|x\w{2}|u\w{4}|U\w{8})/
              }
            ]
          }
        ]
      },
      {
        scope: "number",
        variants: [
          { begin: "\\b0b([01_]+)" + NUMBER_SUFFIX },
          { begin: "\\b0o([0-7_]+)" + NUMBER_SUFFIX },
          { begin: "\\b0x([A-Fa-f0-9_]+)" + NUMBER_SUFFIX },
          { begin: "\\b(\\d[\\d_]*(\\.[0-9_]+)?([eE][+-]?[0-9_]+)?)" + NUMBER_SUFFIX }
        ],
        relevance: 0
      },
      {
        begin: [
          /\bsafe/,
          /\s+/,
          /extern/
        ],
        scope: {
          1: "keyword",
          3: "keyword"
        }
      },
      {
        begin: [
          /fn/,
          /\s+/,
          UNDERSCORE_IDENT_RE
        ],
        scope: {
          1: "keyword",
          3: "title.function"
        }
      },
      {
        scope: "meta",
        begin: "#!?\\[",
        end: "\\]",
        contains: [
          {
            scope: "string",
            begin: /"/,
            end: /"/,
            contains: [
              hljs.BACKSLASH_ESCAPE
            ]
          }
        ]
      },
      {
        begin: [
          /let/,
          /\s+/,
          /(?:mut\s+)?/,
          UNDERSCORE_IDENT_RE
        ],
        scope: {
          1: "keyword",
          3: "keyword",
          4: "variable"
        }
      },
      // must come before impl/for rule later
      {
        begin: [
          /for/,
          /\s+/,
          UNDERSCORE_IDENT_RE,
          /\s+/,
          /in/
        ],
        scope: {
          1: "keyword",
          3: "variable",
          5: "keyword"
        }
      },
      {
        begin: [
          /type/,
          /\s+/,
          UNDERSCORE_IDENT_RE
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      },
      {
        begin: [
          /(?:trait|enum|struct|union|impl|for)/,
          /\s+/,
          UNDERSCORE_IDENT_RE
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      },
      {
        begin: hljs.IDENT_RE + "::",
        keywords: {
          keyword: "Self",
          built_in: BUILTINS,
          type: TYPES3
        }
      },
      {
        scope: "punctuation",
        begin: "->"
      },
      FUNCTION_INVOKE
    ]
  };
}

// node_modules/highlight.js/es/languages/scss.js
var MODES3 = (hljs) => {
  return {
    IMPORTANT: {
      scope: "meta",
      begin: "!important"
    },
    BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
    HEXCOLOR: {
      scope: "number",
      begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
    },
    UNICODE_RANGE: {
      scope: "number",
      begin: /\b[Uu]\+[0-9A-Fa-f][0-9A-Fa-f?]{0,5}(-[0-9A-Fa-f][0-9A-Fa-f]{0,5})?/
    },
    FUNCTION_DISPATCH: {
      className: "built_in",
      begin: /[\w-]+(?=\()/
    },
    ATTRIBUTE_SELECTOR_MODE: {
      scope: "selector-attr",
      begin: /\[/,
      end: /\]/,
      illegal: "$",
      contains: [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ]
    },
    CSS_NUMBER_MODE: {
      scope: "number",
      begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
      relevance: 0
    },
    CSS_VARIABLE: {
      className: "attr",
      begin: /--[A-Za-z_][A-Za-z0-9_-]*/
    }
  };
};
var HTML_TAGS3 = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
  "body",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "object",
  "ol",
  "optgroup",
  "option",
  "p",
  "picture",
  "q",
  "quote",
  "samp",
  "section",
  "select",
  "source",
  "span",
  "strong",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
  "var",
  "video"
];
var SVG_TAGS3 = [
  "defs",
  "g",
  "marker",
  "mask",
  "pattern",
  "svg",
  "switch",
  "symbol",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feFlood",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feTile",
  "feTurbulence",
  "linearGradient",
  "radialGradient",
  "stop",
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
  "textPath",
  "tspan",
  "foreignObject",
  "clipPath"
];
var TAGS3 = [
  ...HTML_TAGS3,
  ...SVG_TAGS3
];
var MEDIA_FEATURES3 = [
  "any-hover",
  "any-pointer",
  "aspect-ratio",
  "color",
  "color-gamut",
  "color-index",
  "device-aspect-ratio",
  "device-height",
  "device-width",
  "display-mode",
  "forced-colors",
  "grid",
  "height",
  "hover",
  "inverted-colors",
  "monochrome",
  "orientation",
  "overflow-block",
  "overflow-inline",
  "pointer",
  "prefers-color-scheme",
  "prefers-contrast",
  "prefers-reduced-motion",
  "prefers-reduced-transparency",
  "resolution",
  "scan",
  "scripting",
  "update",
  "width",
  // TODO: find a better solution?
  "min-width",
  "max-width",
  "min-height",
  "max-height"
].sort().reverse();
var PSEUDO_CLASSES3 = [
  "active",
  "any-link",
  "blank",
  "checked",
  "current",
  "default",
  "defined",
  "dir",
  // dir()
  "disabled",
  "drop",
  "empty",
  "enabled",
  "first",
  "first-child",
  "first-of-type",
  "fullscreen",
  "future",
  "focus",
  "focus-visible",
  "focus-within",
  "has",
  // has()
  "host",
  // host or host()
  "host-context",
  // host-context()
  "hover",
  "indeterminate",
  "in-range",
  "invalid",
  "is",
  // is()
  "lang",
  // lang()
  "last-child",
  "last-of-type",
  "left",
  "link",
  "local-link",
  "not",
  // not()
  "nth-child",
  // nth-child()
  "nth-col",
  // nth-col()
  "nth-last-child",
  // nth-last-child()
  "nth-last-col",
  // nth-last-col()
  "nth-last-of-type",
  //nth-last-of-type()
  "nth-of-type",
  //nth-of-type()
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "past",
  "placeholder-shown",
  "read-only",
  "read-write",
  "required",
  "right",
  "root",
  "scope",
  "target",
  "target-within",
  "user-invalid",
  "valid",
  "visited",
  "where"
  // where()
].sort().reverse();
var PSEUDO_ELEMENTS3 = [
  "after",
  "backdrop",
  "before",
  "cue",
  "cue-region",
  "first-letter",
  "first-line",
  "grammar-error",
  "marker",
  "part",
  "placeholder",
  "selection",
  "slotted",
  "spelling-error"
].sort().reverse();
var ATTRIBUTES3 = [
  "accent-color",
  "align-content",
  "align-items",
  "align-self",
  "alignment-baseline",
  "all",
  "anchor-name",
  "animation",
  "animation-composition",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-range",
  "animation-range-end",
  "animation-range-start",
  "animation-timeline",
  "animation-timing-function",
  "appearance",
  "aspect-ratio",
  "backdrop-filter",
  "backface-visibility",
  "background",
  "background-attachment",
  "background-blend-mode",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
  "background-position",
  "background-position-x",
  "background-position-y",
  "background-repeat",
  "background-size",
  "baseline-shift",
  "block-size",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-end-color",
  "border-block-end-style",
  "border-block-end-width",
  "border-block-start",
  "border-block-start-color",
  "border-block-start-style",
  "border-block-start-width",
  "border-block-style",
  "border-block-width",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-end-end-radius",
  "border-end-start-radius",
  "border-image",
  "border-image-outset",
  "border-image-repeat",
  "border-image-slice",
  "border-image-source",
  "border-image-width",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-end-color",
  "border-inline-end-style",
  "border-inline-end-width",
  "border-inline-start",
  "border-inline-start-color",
  "border-inline-start-style",
  "border-inline-start-width",
  "border-inline-style",
  "border-inline-width",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-start-end-radius",
  "border-start-start-radius",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-align",
  "box-decoration-break",
  "box-direction",
  "box-flex",
  "box-flex-group",
  "box-lines",
  "box-ordinal-group",
  "box-orient",
  "box-pack",
  "box-shadow",
  "box-sizing",
  "break-after",
  "break-before",
  "break-inside",
  "caption-side",
  "caret-color",
  "clear",
  "clip",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "color-scheme",
  "column-count",
  "column-fill",
  "column-gap",
  "column-rule",
  "column-rule-color",
  "column-rule-style",
  "column-rule-width",
  "column-span",
  "column-width",
  "columns",
  "contain",
  "contain-intrinsic-block-size",
  "contain-intrinsic-height",
  "contain-intrinsic-inline-size",
  "contain-intrinsic-size",
  "contain-intrinsic-width",
  "container",
  "container-name",
  "container-type",
  "content",
  "content-visibility",
  "corner-bottom-left-shape",
  "corner-bottom-right-shape",
  "corner-shape",
  "corner-top-left-shape",
  "corner-top-right-shape",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "cue",
  "cue-after",
  "cue-before",
  "cursor",
  "cx",
  "cy",
  "direction",
  "display",
  "dominant-baseline",
  "empty-cells",
  "enable-background",
  "field-sizing",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "float",
  "flood-color",
  "flood-opacity",
  "flow",
  "font",
  "font-display",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-smooth",
  "font-smoothing",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-synthesis-position",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "forced-color-adjust",
  "gap",
  "glyph-orientation-horizontal",
  "glyph-orientation-vertical",
  "grid",
  "grid-area",
  "grid-auto-columns",
  "grid-auto-flow",
  "grid-auto-rows",
  "grid-column",
  "grid-column-end",
  "grid-column-start",
  "grid-gap",
  "grid-row",
  "grid-row-end",
  "grid-row-start",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "hanging-punctuation",
  "height",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "icon",
  "image-orientation",
  "image-rendering",
  "image-resolution",
  "ime-mode",
  "initial-letter",
  "initial-letter-align",
  "inline-size",
  "inset",
  "inset-area",
  "inset-block",
  "inset-block-end",
  "inset-block-start",
  "inset-inline",
  "inset-inline-end",
  "inset-inline-start",
  "isolation",
  "justify-content",
  "justify-items",
  "justify-self",
  "kerning",
  "left",
  "letter-spacing",
  "lighting-color",
  "line-break",
  "line-height",
  "line-height-step",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-block",
  "margin-block-end",
  "margin-block-start",
  "margin-bottom",
  "margin-inline",
  "margin-inline-end",
  "margin-inline-start",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-trim",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "marks",
  "mask",
  "mask-border",
  "mask-border-mode",
  "mask-border-outset",
  "mask-border-repeat",
  "mask-border-slice",
  "mask-border-source",
  "mask-border-width",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "mask-type",
  "masonry-auto-flow",
  "math-depth",
  "math-shift",
  "math-style",
  "max-block-size",
  "max-height",
  "max-inline-size",
  "max-width",
  "min-block-size",
  "min-height",
  "min-inline-size",
  "min-width",
  "mix-blend-mode",
  "nav-down",
  "nav-index",
  "nav-left",
  "nav-right",
  "nav-up",
  "none",
  "normal",
  "object-fit",
  "object-position",
  "offset",
  "offset-anchor",
  "offset-distance",
  "offset-path",
  "offset-position",
  "offset-rotate",
  "opacity",
  "order",
  "orphans",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow",
  "overflow-anchor",
  "overflow-block",
  "overflow-clip-margin",
  "overflow-inline",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "overlay",
  "overscroll-behavior",
  "overscroll-behavior-block",
  "overscroll-behavior-inline",
  "overscroll-behavior-x",
  "overscroll-behavior-y",
  "padding",
  "padding-block",
  "padding-block-end",
  "padding-block-start",
  "padding-bottom",
  "padding-inline",
  "padding-inline-end",
  "padding-inline-start",
  "padding-left",
  "padding-right",
  "padding-top",
  "page",
  "page-break-after",
  "page-break-before",
  "page-break-inside",
  "paint-order",
  "pause",
  "pause-after",
  "pause-before",
  "perspective",
  "perspective-origin",
  "place-content",
  "place-items",
  "place-self",
  "pointer-events",
  "position",
  "position-anchor",
  "position-visibility",
  "print-color-adjust",
  "quotes",
  "r",
  "resize",
  "rest",
  "rest-after",
  "rest-before",
  "right",
  "rotate",
  "row-gap",
  "ruby-align",
  "ruby-position",
  "scale",
  "scroll-behavior",
  "scroll-margin",
  "scroll-margin-block",
  "scroll-margin-block-end",
  "scroll-margin-block-start",
  "scroll-margin-bottom",
  "scroll-margin-inline",
  "scroll-margin-inline-end",
  "scroll-margin-inline-start",
  "scroll-margin-left",
  "scroll-margin-right",
  "scroll-margin-top",
  "scroll-padding",
  "scroll-padding-block",
  "scroll-padding-block-end",
  "scroll-padding-block-start",
  "scroll-padding-bottom",
  "scroll-padding-inline",
  "scroll-padding-inline-end",
  "scroll-padding-inline-start",
  "scroll-padding-left",
  "scroll-padding-right",
  "scroll-padding-top",
  "scroll-snap-align",
  "scroll-snap-stop",
  "scroll-snap-type",
  "scroll-timeline",
  "scroll-timeline-axis",
  "scroll-timeline-name",
  "scrollbar-color",
  "scrollbar-gutter",
  "scrollbar-width",
  "shape-image-threshold",
  "shape-margin",
  "shape-outside",
  "shape-rendering",
  "speak",
  "speak-as",
  "src",
  // @font-face
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "table-layout",
  "text-align",
  "text-align-all",
  "text-align-last",
  "text-anchor",
  "text-combine-upright",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-skip",
  "text-decoration-skip-ink",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-emphasis",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-justify",
  "text-orientation",
  "text-overflow",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "timeline-scope",
  "top",
  "touch-action",
  "transform",
  "transform-box",
  "transform-origin",
  "transform-style",
  "transition",
  "transition-behavior",
  "transition-delay",
  "transition-duration",
  "transition-property",
  "transition-timing-function",
  "translate",
  "unicode-bidi",
  "unicode-range",
  "user-modify",
  "user-select",
  "vector-effect",
  "vertical-align",
  "view-timeline",
  "view-timeline-axis",
  "view-timeline-inset",
  "view-timeline-name",
  "view-transition-name",
  "visibility",
  "voice-balance",
  "voice-duration",
  "voice-family",
  "voice-pitch",
  "voice-range",
  "voice-rate",
  "voice-stress",
  "voice-volume",
  "white-space",
  "white-space-collapse",
  "widows",
  "width",
  "will-change",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "x",
  "y",
  "z-index",
  "zoom"
].sort().reverse();
function scss(hljs) {
  const modes = MODES3(hljs);
  const PSEUDO_ELEMENTS$1 = PSEUDO_ELEMENTS3;
  const PSEUDO_CLASSES$1 = PSEUDO_CLASSES3;
  const AT_IDENTIFIER = "@[a-z-]+";
  const AT_MODIFIERS = "and or not only";
  const IDENT_RE3 = "[a-zA-Z-][a-zA-Z0-9_-]*";
  const VARIABLE = {
    className: "variable",
    begin: "(\\$" + IDENT_RE3 + ")\\b",
    relevance: 0
  };
  return {
    name: "SCSS",
    case_insensitive: true,
    illegal: "[=/|']",
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      // to recognize keyframe 40% etc which are outside the scope of our
      // attribute value mode
      modes.CSS_NUMBER_MODE,
      {
        className: "selector-id",
        begin: "#[A-Za-z0-9_-]+",
        relevance: 0
      },
      {
        className: "selector-class",
        begin: "\\.[A-Za-z0-9_-]+",
        relevance: 0
      },
      modes.ATTRIBUTE_SELECTOR_MODE,
      {
        className: "selector-tag",
        begin: "\\b(" + TAGS3.join("|") + ")\\b",
        // was there, before, but why?
        relevance: 0
      },
      {
        className: "selector-pseudo",
        begin: ":(" + PSEUDO_CLASSES$1.join("|") + ")"
      },
      {
        className: "selector-pseudo",
        begin: ":(:)?(" + PSEUDO_ELEMENTS$1.join("|") + ")"
      },
      VARIABLE,
      {
        // pseudo-selector params
        begin: /\(/,
        end: /\)/,
        contains: [modes.CSS_NUMBER_MODE]
      },
      modes.CSS_VARIABLE,
      {
        className: "attribute",
        begin: "\\b(" + ATTRIBUTES3.join("|") + ")\\b"
      },
      { begin: "\\b(whitespace|wait|w-resize|visible|vertical-text|vertical-ideographic|uppercase|upper-roman|upper-alpha|underline|transparent|top|thin|thick|text|text-top|text-bottom|tb-rl|table-header-group|table-footer-group|sw-resize|super|strict|static|square|solid|small-caps|separate|se-resize|scroll|s-resize|rtl|row-resize|ridge|right|repeat|repeat-y|repeat-x|relative|progress|pointer|overline|outside|outset|oblique|nowrap|not-allowed|normal|none|nw-resize|no-repeat|no-drop|newspaper|ne-resize|n-resize|move|middle|medium|ltr|lr-tb|lowercase|lower-roman|lower-alpha|loose|list-item|line|line-through|line-edge|lighter|left|keep-all|justify|italic|inter-word|inter-ideograph|inside|inset|inline|inline-block|inherit|inactive|ideograph-space|ideograph-parenthesis|ideograph-numeric|ideograph-alpha|horizontal|hidden|help|hand|groove|fixed|ellipsis|e-resize|double|dotted|distribute|distribute-space|distribute-letter|distribute-all-lines|disc|disabled|default|decimal|dashed|crosshair|collapse|col-resize|circle|char|center|capitalize|break-word|break-all|bottom|both|bolder|bold|block|bidi-override|below|baseline|auto|always|all-scroll|absolute|table|table-cell)\\b" },
      {
        begin: /:/,
        end: /[;}{]/,
        relevance: 0,
        contains: [
          modes.BLOCK_COMMENT,
          VARIABLE,
          modes.HEXCOLOR,
          modes.CSS_NUMBER_MODE,
          modes.UNICODE_RANGE,
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          modes.IMPORTANT,
          modes.FUNCTION_DISPATCH
        ]
      },
      // matching these here allows us to treat them more like regular CSS
      // rules so everything between the {} gets regular rule highlighting,
      // which is what we want for page and font-face
      {
        begin: "@(page|font-face)",
        keywords: {
          $pattern: AT_IDENTIFIER,
          keyword: "@page @font-face"
        }
      },
      {
        begin: "@",
        end: "[{;]",
        returnBegin: true,
        keywords: {
          $pattern: /[a-z-]+/,
          keyword: AT_MODIFIERS,
          attribute: MEDIA_FEATURES3.join(" ")
        },
        contains: [
          {
            begin: AT_IDENTIFIER,
            className: "keyword"
          },
          {
            begin: /[a-z-]+(?=:)/,
            className: "attribute"
          },
          VARIABLE,
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          modes.HEXCOLOR,
          modes.CSS_NUMBER_MODE
        ]
      },
      modes.FUNCTION_DISPATCH
    ]
  };
}

// node_modules/highlight.js/es/languages/shell.js
function shell(hljs) {
  return {
    name: "Shell Session",
    aliases: [
      "console",
      "shellsession"
    ],
    contains: [
      {
        className: "meta.prompt",
        // We cannot add \s (spaces) in the regular expression otherwise it will be too broad and produce unexpected result.
        // For instance, in the following example, it would match "echo /path/to/home >" as a prompt:
        // echo /path/to/home > t.exe
        begin: /^\s{0,3}[./~\w\d[\]()@-]*[>%$#][ ]?/,
        starts: {
          end: /[^\\](?=\s*$)/,
          subLanguage: "bash"
        }
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/sql.js
function sql(hljs) {
  const regex = hljs.regex;
  const COMMENT_MODE = hljs.COMMENT("--", "$");
  const STRING = {
    scope: "string",
    variants: [
      {
        begin: /'/,
        end: /'/,
        contains: [{ match: /''/ }]
      }
    ]
  };
  const QUOTED_IDENTIFIER = {
    begin: /"/,
    end: /"/,
    contains: [{ match: /""/ }]
  };
  const LITERALS3 = [
    "true",
    "false",
    // Not sure it's correct to call NULL literal, and clauses like IS [NOT] NULL look strange that way.
    // "null",
    "unknown"
  ];
  const MULTI_WORD_TYPES = [
    "double precision",
    "large object",
    "with timezone",
    "without timezone"
  ];
  const TYPES3 = [
    "bigint",
    "binary",
    "blob",
    "boolean",
    "char",
    "character",
    "clob",
    "date",
    "dec",
    "decfloat",
    "decimal",
    "float",
    "int",
    "integer",
    "interval",
    "nchar",
    "nclob",
    "national",
    "numeric",
    "real",
    "row",
    "smallint",
    "time",
    "timestamp",
    "varchar",
    "varying",
    // modifier (character varying)
    "varbinary"
  ];
  const NON_RESERVED_WORDS = [
    "add",
    "asc",
    "collation",
    "desc",
    "final",
    "first",
    "last",
    "view"
  ];
  const RESERVED_WORDS = [
    "abs",
    "acos",
    "all",
    "allocate",
    "alter",
    "and",
    "any",
    "are",
    "array",
    "array_agg",
    "array_max_cardinality",
    "as",
    "asensitive",
    "asin",
    "asymmetric",
    "at",
    "atan",
    "atomic",
    "authorization",
    "avg",
    "begin",
    "begin_frame",
    "begin_partition",
    "between",
    "bigint",
    "binary",
    "blob",
    "boolean",
    "both",
    "by",
    "call",
    "called",
    "cardinality",
    "cascaded",
    "case",
    "cast",
    "ceil",
    "ceiling",
    "char",
    "char_length",
    "character",
    "character_length",
    "check",
    "classifier",
    "clob",
    "close",
    "coalesce",
    "collate",
    "collect",
    "column",
    "commit",
    "condition",
    "connect",
    "constraint",
    "contains",
    "convert",
    "copy",
    "corr",
    "corresponding",
    "cos",
    "cosh",
    "count",
    "covar_pop",
    "covar_samp",
    "create",
    "cross",
    "cube",
    "cume_dist",
    "current",
    "current_catalog",
    "current_date",
    "current_default_transform_group",
    "current_path",
    "current_role",
    "current_row",
    "current_schema",
    "current_time",
    "current_timestamp",
    "current_path",
    "current_role",
    "current_transform_group_for_type",
    "current_user",
    "cursor",
    "cycle",
    "date",
    "day",
    "deallocate",
    "dec",
    "decimal",
    "decfloat",
    "declare",
    "default",
    "define",
    "delete",
    "dense_rank",
    "deref",
    "describe",
    "deterministic",
    "disconnect",
    "distinct",
    "double",
    "drop",
    "dynamic",
    "each",
    "element",
    "else",
    "empty",
    "end",
    "end_frame",
    "end_partition",
    "end-exec",
    "equals",
    "escape",
    "every",
    "except",
    "exec",
    "execute",
    "exists",
    "exp",
    "external",
    "extract",
    "false",
    "fetch",
    "filter",
    "first_value",
    "float",
    "floor",
    "for",
    "foreign",
    "frame_row",
    "free",
    "from",
    "full",
    "function",
    "fusion",
    "get",
    "global",
    "grant",
    "group",
    "grouping",
    "groups",
    "having",
    "hold",
    "hour",
    "identity",
    "in",
    "indicator",
    "initial",
    "inner",
    "inout",
    "insensitive",
    "insert",
    "int",
    "integer",
    "intersect",
    "intersection",
    "interval",
    "into",
    "is",
    "join",
    "json_array",
    "json_arrayagg",
    "json_exists",
    "json_object",
    "json_objectagg",
    "json_query",
    "json_table",
    "json_table_primitive",
    "json_value",
    "lag",
    "language",
    "large",
    "last_value",
    "lateral",
    "lead",
    "leading",
    "left",
    "like",
    "like_regex",
    "listagg",
    "ln",
    "local",
    "localtime",
    "localtimestamp",
    "log",
    "log10",
    "lower",
    "match",
    "match_number",
    "match_recognize",
    "matches",
    "max",
    "member",
    "merge",
    "method",
    "min",
    "minute",
    "mod",
    "modifies",
    "module",
    "month",
    "multiset",
    "national",
    "natural",
    "nchar",
    "nclob",
    "new",
    "no",
    "none",
    "normalize",
    "not",
    "nth_value",
    "ntile",
    "null",
    "nullif",
    "numeric",
    "octet_length",
    "occurrences_regex",
    "of",
    "offset",
    "old",
    "omit",
    "on",
    "one",
    "only",
    "open",
    "or",
    "order",
    "out",
    "outer",
    "over",
    "overlaps",
    "overlay",
    "parameter",
    "partition",
    "pattern",
    "per",
    "percent",
    "percent_rank",
    "percentile_cont",
    "percentile_disc",
    "period",
    "portion",
    "position",
    "position_regex",
    "power",
    "precedes",
    "precision",
    "prepare",
    "primary",
    "procedure",
    "ptf",
    "range",
    "rank",
    "reads",
    "real",
    "recursive",
    "ref",
    "references",
    "referencing",
    "regr_avgx",
    "regr_avgy",
    "regr_count",
    "regr_intercept",
    "regr_r2",
    "regr_slope",
    "regr_sxx",
    "regr_sxy",
    "regr_syy",
    "release",
    "result",
    "return",
    "returns",
    "revoke",
    "right",
    "rollback",
    "rollup",
    "row",
    "row_number",
    "rows",
    "running",
    "savepoint",
    "scope",
    "scroll",
    "search",
    "second",
    "seek",
    "select",
    "sensitive",
    "session_user",
    "set",
    "show",
    "similar",
    "sin",
    "sinh",
    "skip",
    "smallint",
    "some",
    "specific",
    "specifictype",
    "sql",
    "sqlexception",
    "sqlstate",
    "sqlwarning",
    "sqrt",
    "start",
    "static",
    "stddev_pop",
    "stddev_samp",
    "submultiset",
    "subset",
    "substring",
    "substring_regex",
    "succeeds",
    "sum",
    "symmetric",
    "system",
    "system_time",
    "system_user",
    "table",
    "tablesample",
    "tan",
    "tanh",
    "then",
    "time",
    "timestamp",
    "timezone_hour",
    "timezone_minute",
    "to",
    "trailing",
    "translate",
    "translate_regex",
    "translation",
    "treat",
    "trigger",
    "trim",
    "trim_array",
    "true",
    "truncate",
    "uescape",
    "union",
    "unique",
    "unknown",
    "unnest",
    "update",
    "upper",
    "user",
    "using",
    "value",
    "values",
    "value_of",
    "var_pop",
    "var_samp",
    "varbinary",
    "varchar",
    "varying",
    "versioning",
    "when",
    "whenever",
    "where",
    "width_bucket",
    "window",
    "with",
    "within",
    "without",
    "year"
  ];
  const RESERVED_FUNCTIONS = [
    "abs",
    "acos",
    "array_agg",
    "asin",
    "atan",
    "avg",
    "cast",
    "ceil",
    "ceiling",
    "coalesce",
    "corr",
    "cos",
    "cosh",
    "count",
    "covar_pop",
    "covar_samp",
    "cume_dist",
    "dense_rank",
    "deref",
    "element",
    "exp",
    "extract",
    "first_value",
    "floor",
    "json_array",
    "json_arrayagg",
    "json_exists",
    "json_object",
    "json_objectagg",
    "json_query",
    "json_table",
    "json_table_primitive",
    "json_value",
    "lag",
    "last_value",
    "lead",
    "listagg",
    "ln",
    "log",
    "log10",
    "lower",
    "max",
    "min",
    "mod",
    "nth_value",
    "ntile",
    "nullif",
    "percent_rank",
    "percentile_cont",
    "percentile_disc",
    "position",
    "position_regex",
    "power",
    "rank",
    "regr_avgx",
    "regr_avgy",
    "regr_count",
    "regr_intercept",
    "regr_r2",
    "regr_slope",
    "regr_sxx",
    "regr_sxy",
    "regr_syy",
    "row_number",
    "sin",
    "sinh",
    "sqrt",
    "stddev_pop",
    "stddev_samp",
    "substring",
    "substring_regex",
    "sum",
    "tan",
    "tanh",
    "translate",
    "translate_regex",
    "treat",
    "trim",
    "trim_array",
    "unnest",
    "upper",
    "value_of",
    "var_pop",
    "var_samp",
    "width_bucket"
  ];
  const POSSIBLE_WITHOUT_PARENS = [
    "current_catalog",
    "current_date",
    "current_default_transform_group",
    "current_path",
    "current_role",
    "current_schema",
    "current_transform_group_for_type",
    "current_user",
    "session_user",
    "system_time",
    "system_user",
    "current_time",
    "localtime",
    "current_timestamp",
    "localtimestamp"
  ];
  const COMBOS = [
    "create table",
    "insert into",
    "primary key",
    "foreign key",
    "not null",
    "alter table",
    "add constraint",
    "grouping sets",
    "on overflow",
    "character set",
    "respect nulls",
    "ignore nulls",
    "nulls first",
    "nulls last",
    "depth first",
    "breadth first"
  ];
  const FUNCTIONS = RESERVED_FUNCTIONS;
  const KEYWORDS3 = [
    ...RESERVED_WORDS,
    ...NON_RESERVED_WORDS
  ].filter((keyword) => {
    return !RESERVED_FUNCTIONS.includes(keyword);
  });
  const VARIABLE = {
    scope: "variable",
    match: /@[a-z0-9][a-z0-9_]*/
  };
  const OPERATOR = {
    scope: "operator",
    match: /[-+*/=%^~]|&&?|\|\|?|!=?|<(?:=>?|<|>)?|>[>=]?/,
    relevance: 0
  };
  const FUNCTION_CALL = {
    match: regex.concat(/\b/, regex.either(...FUNCTIONS), /\s*\(/),
    relevance: 0,
    keywords: { built_in: FUNCTIONS }
  };
  function kws_to_regex(list) {
    return regex.concat(
      /\b/,
      regex.either(...list.map((kw) => {
        return kw.replace(/\s+/, "\\s+");
      })),
      /\b/
    );
  }
  const MULTI_WORD_KEYWORDS = {
    scope: "keyword",
    match: kws_to_regex(COMBOS),
    relevance: 0
  };
  function reduceRelevancy(list, {
    exceptions,
    when
  } = {}) {
    const qualifyFn = when;
    exceptions = exceptions || [];
    return list.map((item) => {
      if (item.match(/\|\d+$/) || exceptions.includes(item)) {
        return item;
      } else if (qualifyFn(item)) {
        return `${item}|0`;
      } else {
        return item;
      }
    });
  }
  return {
    name: "SQL",
    case_insensitive: true,
    // does not include {} or HTML tags `</`
    illegal: /[{}]|<\//,
    keywords: {
      $pattern: /\b[\w\.]+/,
      keyword: reduceRelevancy(KEYWORDS3, { when: (x) => x.length < 3 }),
      literal: LITERALS3,
      type: TYPES3,
      built_in: POSSIBLE_WITHOUT_PARENS
    },
    contains: [
      {
        scope: "type",
        match: kws_to_regex(MULTI_WORD_TYPES)
      },
      MULTI_WORD_KEYWORDS,
      FUNCTION_CALL,
      VARIABLE,
      STRING,
      QUOTED_IDENTIFIER,
      hljs.C_NUMBER_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      COMMENT_MODE,
      OPERATOR
    ]
  };
}

// node_modules/highlight.js/es/languages/swift.js
function source(re) {
  if (!re) return null;
  if (typeof re === "string") return re;
  return re.source;
}
function lookahead(re) {
  return concat("(?=", re, ")");
}
function concat(...args) {
  const joined = args.map((x) => source(x)).join("");
  return joined;
}
function stripOptionsFromArgs(args) {
  const opts = args[args.length - 1];
  if (typeof opts === "object" && opts.constructor === Object) {
    args.splice(args.length - 1, 1);
    return opts;
  } else {
    return {};
  }
}
function either(...args) {
  const opts = stripOptionsFromArgs(args);
  const joined = "(" + (opts.capture ? "" : "?:") + args.map((x) => source(x)).join("|") + ")";
  return joined;
}
new RegExp(either(
  /\[(?:[^\\\]]|\\.)*\]/,
  // a character class, inside which ( and \ lose their meaning
  /\(\?<(?![=!])[^>]+>/,
  // a named capture group `(?<name>` (not a lookbehind `(?<=` / `(?<!`)
  /\(\?'[^']+'/,
  // a named capture group `(?'name'`
  /\(\??/,
  // an opening parenthesis, capturing or non-capturing / lookahead
  /\\([1-9][0-9]*)/,
  // a backreference like `\1`
  /\\./
  // any other escape sequence
));
var keywordWrapper = (keyword) => concat(
  /\b/,
  keyword,
  /\w$/.test(keyword) ? /\b/ : /\B/
);
var dotKeywords = [
  "Protocol",
  // contextual
  "Type"
  // contextual
].map(keywordWrapper);
var optionalDotKeywords = [
  "init",
  "self"
].map(keywordWrapper);
var keywordTypes = [
  "Any",
  "Self"
];
var keywords = [
  // strings below will be fed into the regular `keywords` engine while regex
  // will result in additional modes being created to scan for those keywords to
  // avoid conflicts with other rules
  "actor",
  "any",
  // contextual
  "associatedtype",
  "async",
  "await",
  /as\?/,
  // operator
  /as!/,
  // operator
  "as",
  // operator
  "borrowing",
  // contextual
  "break",
  "case",
  "catch",
  "class",
  "consume",
  // contextual
  "consuming",
  // contextual
  "continue",
  "convenience",
  // contextual
  "copy",
  // contextual
  "default",
  "defer",
  "deinit",
  "didSet",
  // contextual
  "distributed",
  "do",
  "dynamic",
  // contextual
  "each",
  "else",
  "enum",
  "extension",
  "fallthrough",
  /fileprivate\(set\)/,
  "fileprivate",
  "final",
  // contextual
  "for",
  "func",
  "get",
  // contextual
  "guard",
  "if",
  "import",
  "indirect",
  // contextual
  "infix",
  // contextual
  /init\?/,
  /init!/,
  "inout",
  /internal\(set\)/,
  "internal",
  "in",
  "is",
  // operator
  "isolated",
  // contextual
  "nonisolated",
  // contextual
  "lazy",
  // contextual
  "let",
  "macro",
  "mutating",
  // contextual
  "nonmutating",
  // contextual
  /open\(set\)/,
  // contextual
  "open",
  // contextual
  "operator",
  "optional",
  // contextual
  "override",
  // contextual
  "package",
  "postfix",
  // contextual
  "precedencegroup",
  "prefix",
  // contextual
  /private\(set\)/,
  "private",
  "protocol",
  /public\(set\)/,
  "public",
  "repeat",
  "required",
  // contextual
  "rethrows",
  "return",
  "set",
  // contextual
  "some",
  // contextual
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throws",
  "throw",
  /try\?/,
  // operator
  /try!/,
  // operator
  "try",
  // operator
  "typealias",
  /unowned\(safe\)/,
  // contextual
  /unowned\(unsafe\)/,
  // contextual
  "unowned",
  // contextual
  "var",
  "weak",
  // contextual
  "where",
  "while",
  "willSet"
  // contextual
];
var literals = [
  "false",
  "nil",
  "true"
];
var precedencegroupKeywords = [
  "assignment",
  "associativity",
  "higherThan",
  "left",
  "lowerThan",
  "none",
  "right"
];
var numberSignKeywords = [
  "#colorLiteral",
  "#column",
  "#dsohandle",
  "#else",
  "#elseif",
  "#endif",
  "#error",
  "#file",
  "#fileID",
  "#fileLiteral",
  "#filePath",
  "#function",
  "#if",
  "#imageLiteral",
  "#keyPath",
  "#line",
  "#selector",
  "#sourceLocation",
  "#warning"
];
var builtIns = [
  "abs",
  "all",
  "any",
  "assert",
  "assertionFailure",
  "debugPrint",
  "dump",
  "fatalError",
  "getVaList",
  "isKnownUniquelyReferenced",
  "max",
  "min",
  "numericCast",
  "pointwiseMax",
  "pointwiseMin",
  "precondition",
  "preconditionFailure",
  "print",
  "readLine",
  "repeatElement",
  "sequence",
  "stride",
  "swap",
  "swift_unboxFromSwiftValueWithType",
  "transcode",
  "type",
  "unsafeBitCast",
  "unsafeDowncast",
  "withExtendedLifetime",
  "withUnsafeMutablePointer",
  "withUnsafePointer",
  "withVaList",
  "withoutActuallyEscaping",
  "zip"
];
var operatorHead = either(
  /[/=\-+!*%<>&|^~?]/,
  /[\u00A1-\u00A7]/,
  /[\u00A9\u00AB]/,
  /[\u00AC\u00AE]/,
  /[\u00B0\u00B1]/,
  /[\u00B6\u00BB\u00BF\u00D7\u00F7]/,
  /[\u2016-\u2017]/,
  /[\u2020-\u2027]/,
  /[\u2030-\u203E]/,
  /[\u2041-\u2053]/,
  /[\u2055-\u205E]/,
  /[\u2190-\u23FF]/,
  /[\u2500-\u2775]/,
  /[\u2794-\u2BFF]/,
  /[\u2E00-\u2E7F]/,
  /[\u3001-\u3003]/,
  /[\u3008-\u3020]/,
  /[\u3030]/
);
var operatorCharacter = either(
  operatorHead,
  /[\u0300-\u036F]/,
  /[\u1DC0-\u1DFF]/,
  /[\u20D0-\u20FF]/,
  /[\uFE00-\uFE0F]/,
  /[\uFE20-\uFE2F]/
  // TODO: The following characters are also allowed, but the regex isn't supported yet.
  // /[\u{E0100}-\u{E01EF}]/u
);
var operator = concat(operatorHead, operatorCharacter, "*");
var identifierHead = either(
  /[a-zA-Z_]/,
  /[\u00A8\u00AA\u00AD\u00AF\u00B2-\u00B5\u00B7-\u00BA]/,
  /[\u00BC-\u00BE\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/,
  /[\u0100-\u02FF\u0370-\u167F\u1681-\u180D\u180F-\u1DBF]/,
  /[\u1E00-\u1FFF]/,
  /[\u200B-\u200D\u202A-\u202E\u203F-\u2040\u2054\u2060-\u206F]/,
  /[\u2070-\u20CF\u2100-\u218F\u2460-\u24FF\u2776-\u2793]/,
  /[\u2C00-\u2DFF\u2E80-\u2FFF]/,
  /[\u3004-\u3007\u3021-\u302F\u3031-\u303F\u3040-\uD7FF]/,
  /[\uF900-\uFD3D\uFD40-\uFDCF\uFDF0-\uFE1F\uFE30-\uFE44]/,
  /[\uFE47-\uFEFE\uFF00-\uFFFD]/
  // Should be /[\uFE47-\uFFFD]/, but we have to exclude FEFF.
  // The following characters are also allowed, but the regexes aren't supported yet.
  // /[\u{10000}-\u{1FFFD}\u{20000-\u{2FFFD}\u{30000}-\u{3FFFD}\u{40000}-\u{4FFFD}]/u,
  // /[\u{50000}-\u{5FFFD}\u{60000-\u{6FFFD}\u{70000}-\u{7FFFD}\u{80000}-\u{8FFFD}]/u,
  // /[\u{90000}-\u{9FFFD}\u{A0000-\u{AFFFD}\u{B0000}-\u{BFFFD}\u{C0000}-\u{CFFFD}]/u,
  // /[\u{D0000}-\u{DFFFD}\u{E0000-\u{EFFFD}]/u
);
var identifierCharacter = either(
  identifierHead,
  /\d/,
  /[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/
);
var identifier = concat(identifierHead, identifierCharacter, "*");
var typeIdentifier = concat(/[A-Z]/, identifierCharacter, "*");
var keywordAttributes = [
  "attached",
  "autoclosure",
  concat(/convention\(/, either("swift", "block", "c"), /\)/),
  "discardableResult",
  "dynamicCallable",
  "dynamicMemberLookup",
  "escaping",
  "freestanding",
  "frozen",
  "GKInspectable",
  "IBAction",
  "IBDesignable",
  "IBInspectable",
  "IBOutlet",
  "IBSegueAction",
  "inlinable",
  "main",
  "nonobjc",
  "NSApplicationMain",
  "NSCopying",
  "NSManaged",
  concat(/objc\(/, identifier, /\)/),
  "objc",
  "objcMembers",
  "propertyWrapper",
  "requires_stored_property_inits",
  "resultBuilder",
  "Sendable",
  "testable",
  "UIApplicationMain",
  "unchecked",
  "unknown",
  "usableFromInline",
  "warn_unqualified_access"
];
var availabilityKeywords = [
  "iOS",
  "iOSApplicationExtension",
  "macOS",
  "macOSApplicationExtension",
  "macCatalyst",
  "macCatalystApplicationExtension",
  "watchOS",
  "watchOSApplicationExtension",
  "tvOS",
  "tvOSApplicationExtension",
  "swift"
];
function swift(hljs) {
  const WHITESPACE = {
    match: /\s+/,
    relevance: 0
  };
  const BLOCK_COMMENT = hljs.COMMENT(
    "/\\*",
    "\\*/",
    { contains: ["self"] }
  );
  const COMMENTS = [
    hljs.C_LINE_COMMENT_MODE,
    BLOCK_COMMENT
  ];
  const DOT_KEYWORD = {
    match: [
      /\./,
      either(...dotKeywords, ...optionalDotKeywords)
    ],
    className: { 2: "keyword" }
  };
  const KEYWORD_GUARD = {
    // Consume .keyword to prevent highlighting properties and methods as keywords.
    match: concat(/\./, either(...keywords)),
    relevance: 0
  };
  const PLAIN_KEYWORDS = keywords.filter((kw) => typeof kw === "string").concat(["_|0"]);
  const REGEX_KEYWORDS = keywords.filter((kw) => typeof kw !== "string").concat(keywordTypes).map(keywordWrapper);
  const KEYWORD = { variants: [
    {
      className: "keyword",
      match: either(...REGEX_KEYWORDS, ...optionalDotKeywords)
    }
  ] };
  const KEYWORDS3 = {
    $pattern: either(
      /\b\w+/,
      // regular keywords
      /#\w+/
      // number keywords
    ),
    keyword: PLAIN_KEYWORDS.concat(numberSignKeywords),
    literal: literals
  };
  const KEYWORD_MODES = [
    DOT_KEYWORD,
    KEYWORD_GUARD,
    KEYWORD
  ];
  const BUILT_IN_GUARD = {
    // Consume .built_in to prevent highlighting properties and methods.
    match: concat(/\./, either(...builtIns)),
    relevance: 0
  };
  const BUILT_IN = {
    className: "built_in",
    match: concat(/\b/, either(...builtIns), /(?=\()/)
  };
  const BUILT_INS3 = [
    BUILT_IN_GUARD,
    BUILT_IN
  ];
  const OPERATOR_GUARD = {
    // Prevent -> from being highlighting as an operator.
    match: /->/,
    relevance: 0
  };
  const OPERATOR = {
    className: "operator",
    relevance: 0,
    variants: [
      { match: operator },
      {
        // dot-operator: only operators that start with a dot are allowed to use dots as
        // characters (..., ...<, .*, etc). So there rule here is: a dot followed by one or more
        // characters that may also include dots.
        match: `\\.(\\.|${operatorCharacter})+`
      }
    ]
  };
  const OPERATORS = [
    OPERATOR_GUARD,
    OPERATOR
  ];
  const decimalDigits3 = "([0-9]_*)+";
  const hexDigits3 = "([0-9a-fA-F]_*)+";
  const NUMBER = {
    className: "number",
    relevance: 0,
    variants: [
      // decimal floating-point-literal (subsumes decimal-literal)
      { match: `\\b(${decimalDigits3})(\\.(${decimalDigits3}))?([eE][+-]?(${decimalDigits3}))?\\b` },
      // hexadecimal floating-point-literal (subsumes hexadecimal-literal)
      { match: `\\b0x(${hexDigits3})(\\.(${hexDigits3}))?([pP][+-]?(${decimalDigits3}))?\\b` },
      // octal-literal
      { match: /\b0o([0-7]_*)+\b/ },
      // binary-literal
      { match: /\b0b([01]_*)+\b/ }
    ]
  };
  const ESCAPED_CHARACTER = (rawDelimiter = "") => ({
    className: "subst",
    variants: [
      { match: concat(/\\/, rawDelimiter, /[0\\tnr"']/) },
      { match: concat(/\\/, rawDelimiter, /u\{[0-9a-fA-F]{1,8}\}/) }
    ]
  });
  const ESCAPED_NEWLINE = (rawDelimiter = "") => ({
    className: "subst",
    match: concat(/\\/, rawDelimiter, /[\t ]*(?:[\r\n]|\r\n)/)
  });
  const INTERPOLATION = (rawDelimiter = "") => ({
    className: "subst",
    label: "interpol",
    begin: concat(/\\/, rawDelimiter, /\(/),
    end: /\)/
  });
  const MULTILINE_STRING = (rawDelimiter = "") => ({
    begin: concat(rawDelimiter, /"""/),
    end: concat(/"""/, rawDelimiter),
    contains: [
      ESCAPED_CHARACTER(rawDelimiter),
      ESCAPED_NEWLINE(rawDelimiter),
      INTERPOLATION(rawDelimiter)
    ]
  });
  const SINGLE_LINE_STRING = (rawDelimiter = "") => ({
    begin: concat(rawDelimiter, /"/),
    end: concat(/"/, rawDelimiter),
    contains: [
      ESCAPED_CHARACTER(rawDelimiter),
      INTERPOLATION(rawDelimiter)
    ]
  });
  const STRING = {
    className: "string",
    variants: [
      MULTILINE_STRING(),
      MULTILINE_STRING("#"),
      MULTILINE_STRING("##"),
      MULTILINE_STRING("###"),
      SINGLE_LINE_STRING(),
      SINGLE_LINE_STRING("#"),
      SINGLE_LINE_STRING("##"),
      SINGLE_LINE_STRING("###")
    ]
  };
  const REGEXP_CONTENTS = [
    hljs.BACKSLASH_ESCAPE,
    {
      begin: /\[/,
      end: /\]/,
      relevance: 0,
      contains: [hljs.BACKSLASH_ESCAPE]
    }
  ];
  const BARE_REGEXP_LITERAL = {
    begin: /\/[^\s](?=[^/\n]*\/)/,
    end: /\//,
    contains: REGEXP_CONTENTS
  };
  const EXTENDED_REGEXP_LITERAL = (rawDelimiter) => {
    const begin = concat(rawDelimiter, /\//);
    const end = concat(/\//, rawDelimiter);
    return {
      begin,
      end,
      contains: [
        ...REGEXP_CONTENTS,
        {
          scope: "comment",
          begin: `#(?!.*${end})`,
          end: /$/
        }
      ]
    };
  };
  const REGEXP = {
    scope: "regexp",
    variants: [
      EXTENDED_REGEXP_LITERAL("###"),
      EXTENDED_REGEXP_LITERAL("##"),
      EXTENDED_REGEXP_LITERAL("#"),
      BARE_REGEXP_LITERAL
    ]
  };
  const QUOTED_IDENTIFIER = { match: concat(/`/, identifier, /`/) };
  const IMPLICIT_PARAMETER = {
    className: "variable",
    match: /\$\d+/
  };
  const PROPERTY_WRAPPER_PROJECTION = {
    className: "variable",
    match: `\\$${identifierCharacter}+`
  };
  const IDENTIFIERS = [
    QUOTED_IDENTIFIER,
    IMPLICIT_PARAMETER,
    PROPERTY_WRAPPER_PROJECTION
  ];
  const AVAILABLE_ATTRIBUTE = {
    match: /(@|#(un)?)available/,
    scope: "keyword",
    starts: { contains: [
      {
        begin: /\(/,
        end: /\)/,
        keywords: availabilityKeywords,
        contains: [
          ...OPERATORS,
          NUMBER,
          STRING
        ]
      }
    ] }
  };
  const KEYWORD_ATTRIBUTE = {
    scope: "keyword",
    match: concat(/@/, either(...keywordAttributes), lookahead(either(/\(/, /\s+/)))
  };
  const USER_DEFINED_ATTRIBUTE = {
    scope: "meta",
    match: concat(/@/, identifier)
  };
  const ATTRIBUTES4 = [
    AVAILABLE_ATTRIBUTE,
    KEYWORD_ATTRIBUTE,
    USER_DEFINED_ATTRIBUTE
  ];
  const TYPE = {
    match: lookahead(/\b[A-Z]/),
    relevance: 0,
    contains: [
      {
        // Common Apple frameworks, for relevance boost
        className: "type",
        match: concat(/(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)/, identifierCharacter, "+")
      },
      {
        // Type identifier
        className: "type",
        match: typeIdentifier,
        relevance: 0
      },
      {
        // Optional type
        match: /[?!]+/,
        relevance: 0
      },
      {
        // Variadic parameter
        match: /\.\.\./,
        relevance: 0
      },
      {
        // Protocol composition
        match: concat(/\s+&\s+/, lookahead(typeIdentifier)),
        relevance: 0
      }
    ]
  };
  const GENERIC_ARGUMENTS = {
    begin: /</,
    end: />/,
    keywords: KEYWORDS3,
    contains: [
      ...COMMENTS,
      ...KEYWORD_MODES,
      ...ATTRIBUTES4,
      OPERATOR_GUARD,
      TYPE
    ]
  };
  TYPE.contains.push(GENERIC_ARGUMENTS);
  const TUPLE_ELEMENT_NAME = {
    match: concat(identifier, /\s*:/),
    keywords: "_|0",
    relevance: 0
  };
  const TUPLE = {
    begin: /\(/,
    end: /\)/,
    relevance: 0,
    keywords: KEYWORDS3,
    contains: [
      "self",
      TUPLE_ELEMENT_NAME,
      ...COMMENTS,
      REGEXP,
      ...KEYWORD_MODES,
      ...BUILT_INS3,
      ...OPERATORS,
      NUMBER,
      STRING,
      ...IDENTIFIERS,
      ...ATTRIBUTES4,
      TYPE
    ]
  };
  const GENERIC_PARAMETERS = {
    begin: /</,
    end: />/,
    keywords: "repeat each",
    contains: [
      ...COMMENTS,
      TYPE
    ]
  };
  const FUNCTION_PARAMETER_NAME = {
    begin: either(
      lookahead(concat(identifier, /\s*:/)),
      lookahead(concat(identifier, /\s+/, identifier, /\s*:/))
    ),
    end: /:/,
    relevance: 0,
    contains: [
      {
        className: "keyword",
        match: /\b_\b/
      },
      {
        className: "params",
        match: identifier
      }
    ]
  };
  const FUNCTION_PARAMETERS = {
    begin: /\(/,
    end: /\)/,
    keywords: KEYWORDS3,
    contains: [
      FUNCTION_PARAMETER_NAME,
      ...COMMENTS,
      ...KEYWORD_MODES,
      ...OPERATORS,
      NUMBER,
      STRING,
      ...ATTRIBUTES4,
      TYPE,
      TUPLE
    ],
    endsParent: true,
    illegal: /["']/
  };
  const FUNCTION_OR_MACRO = {
    match: [
      /(func|macro)/,
      /\s+/,
      either(QUOTED_IDENTIFIER.match, identifier, operator)
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      GENERIC_PARAMETERS,
      FUNCTION_PARAMETERS,
      WHITESPACE
    ],
    illegal: [
      /\[/,
      /%/
    ]
  };
  const INIT_SUBSCRIPT = {
    match: [
      /\b(?:subscript|init[?!]?)/,
      /\s*(?=[<(])/
    ],
    className: { 1: "keyword" },
    contains: [
      GENERIC_PARAMETERS,
      FUNCTION_PARAMETERS,
      WHITESPACE
    ],
    illegal: /\[|%/
  };
  const OPERATOR_DECLARATION = {
    match: [
      /operator/,
      /\s+/,
      operator
    ],
    className: {
      1: "keyword",
      3: "title"
    }
  };
  const PRECEDENCEGROUP = {
    begin: [
      /precedencegroup/,
      /\s+/,
      typeIdentifier
    ],
    className: {
      1: "keyword",
      3: "title"
    },
    contains: [TYPE],
    keywords: [
      ...precedencegroupKeywords,
      ...literals
    ],
    end: /}/
  };
  const CLASS_FUNC_DECLARATION = {
    match: [
      /class\b/,
      /\s+/,
      /func\b/,
      /\s+/,
      /\b[A-Za-z_][A-Za-z0-9_]*\b/
    ],
    scope: {
      1: "keyword",
      3: "keyword",
      5: "title.function"
    }
  };
  const CLASS_VAR_DECLARATION = {
    match: [
      /class\b/,
      /\s+/,
      /var\b/
    ],
    scope: {
      1: "keyword",
      3: "keyword"
    }
  };
  const TYPE_DECLARATION = {
    begin: [
      /(struct|protocol|class|extension|enum|actor)/,
      /\s+/,
      identifier,
      /\s*/
    ],
    beginScope: {
      1: "keyword",
      3: "title.class"
    },
    keywords: KEYWORDS3,
    contains: [
      GENERIC_PARAMETERS,
      ...KEYWORD_MODES,
      {
        begin: /:/,
        end: /\{/,
        keywords: KEYWORDS3,
        contains: [
          {
            scope: "title.class.inherited",
            match: typeIdentifier
          },
          ...KEYWORD_MODES
        ],
        relevance: 0
      }
    ]
  };
  for (const variant of STRING.variants) {
    const interpolation = variant.contains.find((mode) => mode.label === "interpol");
    interpolation.keywords = KEYWORDS3;
    const submodes = [
      ...KEYWORD_MODES,
      ...BUILT_INS3,
      ...OPERATORS,
      NUMBER,
      STRING,
      ...IDENTIFIERS
    ];
    interpolation.contains = [
      ...submodes,
      {
        begin: /\(/,
        end: /\)/,
        contains: [
          "self",
          ...submodes
        ]
      }
    ];
  }
  return {
    name: "Swift",
    keywords: KEYWORDS3,
    contains: [
      ...COMMENTS,
      FUNCTION_OR_MACRO,
      INIT_SUBSCRIPT,
      CLASS_FUNC_DECLARATION,
      CLASS_VAR_DECLARATION,
      TYPE_DECLARATION,
      OPERATOR_DECLARATION,
      PRECEDENCEGROUP,
      {
        beginKeywords: "import",
        end: /$/,
        contains: [...COMMENTS],
        relevance: 0
      },
      REGEXP,
      ...KEYWORD_MODES,
      ...BUILT_INS3,
      ...OPERATORS,
      NUMBER,
      STRING,
      ...IDENTIFIERS,
      ...ATTRIBUTES4,
      TYPE,
      TUPLE
    ]
  };
}

// node_modules/highlight.js/es/languages/typescript.js
var IDENT_RE2 = "[A-Za-z$_][0-9A-Za-z$_]*";
var KEYWORDS2 = [
  "as",
  // for exports
  "in",
  "of",
  "if",
  "for",
  "while",
  "finally",
  "var",
  "new",
  "function",
  "do",
  "return",
  "void",
  "else",
  "break",
  "catch",
  "instanceof",
  "with",
  "throw",
  "case",
  "default",
  "try",
  "switch",
  "continue",
  "typeof",
  "delete",
  "let",
  "yield",
  "const",
  "class",
  // JS handles these with a special rule
  // "get",
  // "set",
  "debugger",
  "async",
  "await",
  "static",
  "import",
  "from",
  "export",
  "extends",
  // It's reached stage 3, which is "recommended for implementation":
  "using"
];
var LITERALS2 = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity"
];
var TYPES2 = [
  // Fundamental objects
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  // numbers and dates
  "Math",
  "Date",
  "Number",
  "BigInt",
  // text
  "String",
  "RegExp",
  // Indexed collections
  "Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  // Keyed collections
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  // Structured data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "JSON",
  // Control abstraction objects
  "Promise",
  "Generator",
  "GeneratorFunction",
  "AsyncFunction",
  // Reflection
  "Reflect",
  "Proxy",
  // Internationalization
  "Intl",
  // WebAssembly
  "WebAssembly"
];
var ERROR_TYPES2 = [
  "Error",
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
];
var BUILT_IN_GLOBALS2 = [
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
  "require",
  "exports",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape"
];
var BUILT_IN_VARIABLES2 = [
  "arguments",
  "this",
  "super",
  "console",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "module",
  "self",
  "global"
  // Node.js
];
var BUILT_INS2 = [].concat(
  BUILT_IN_GLOBALS2,
  TYPES2,
  ERROR_TYPES2
);
function javascript2(hljs) {
  const regex = hljs.regex;
  const hasClosingTag = (match, { after }) => {
    const tag = "</" + match[0].slice(1);
    const pos = match.input.indexOf(tag, after);
    return pos !== -1;
  };
  const IDENT_RE$1 = IDENT_RE2;
  const FRAGMENT = {
    begin: "<>",
    end: "</>"
  };
  const XML_SELF_CLOSING = /<[A-Za-z0-9\\._:-]+\s*\/>/;
  const XML_TAG = {
    begin: /<[A-Za-z0-9\\._:-]+/,
    end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
    /**
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    isTrulyOpeningTag: (match, response) => {
      const afterMatchIndex = match[0].length + match.index;
      const nextChar = match.input[afterMatchIndex];
      if (
        // HTML should not include another raw `<` inside a tag
        // nested type?
        // `<Array<Array<number>>`, etc.
        nextChar === "<" || // the , gives away that this is not HTML
        // `<T, A extends keyof T, V>`
        nextChar === ","
      ) {
        response.ignoreMatch();
        return;
      }
      if (nextChar === ">") {
        if (!hasClosingTag(match, { after: afterMatchIndex })) {
          response.ignoreMatch();
        }
      }
      let m;
      const afterMatch = match.input.substring(afterMatchIndex);
      if (m = afterMatch.match(/^\s*=/)) {
        response.ignoreMatch();
        return;
      }
      if (m = afterMatch.match(/^\s+extends\s+/)) {
        if (m.index === 0) {
          response.ignoreMatch();
          return;
        }
      }
    }
  };
  const KEYWORDS$1 = {
    $pattern: IDENT_RE2,
    keyword: KEYWORDS2,
    literal: LITERALS2,
    built_in: BUILT_INS2,
    "variable.language": BUILT_IN_VARIABLES2
  };
  const decimalDigits3 = "[0-9](_?[0-9])*";
  const frac3 = `\\.(${decimalDigits3})`;
  const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
  const NUMBER = {
    className: "number",
    variants: [
      // DecimalLiteral
      { begin: `(\\b(${decimalInteger})((${frac3})|\\.)?|(${frac3}))[eE][+-]?(${decimalDigits3})\\b` },
      { begin: `\\b(${decimalInteger})\\b((${frac3})\\b|\\.)?|(${frac3})\\b` },
      // DecimalBigIntegerLiteral
      { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
      // NonDecimalIntegerLiteral
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
      // LegacyOctalIntegerLiteral (does not include underscore separators)
      // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
      { begin: "\\b0[0-7]+n?\\b" }
    ],
    relevance: 0
  };
  const SUBST = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: KEYWORDS$1,
    contains: []
    // defined later
  };
  const HTML_TEMPLATE = {
    begin: ".?html`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "xml"
    }
  };
  const CSS_TEMPLATE = {
    begin: ".?css`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "css"
    }
  };
  const GRAPHQL_TEMPLATE = {
    begin: ".?gql`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "graphql"
    }
  };
  const TEMPLATE_STRING = {
    className: "string",
    begin: "`",
    end: "`",
    contains: [
      hljs.BACKSLASH_ESCAPE,
      SUBST
    ]
  };
  const JSDOC_COMMENT = hljs.COMMENT(
    /\/\*\*(?!\/)/,
    "\\*/",
    {
      relevance: 0,
      contains: [
        {
          begin: "(?=@[A-Za-z]+)",
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+"
            },
            {
              className: "type",
              begin: "\\{",
              end: "\\}",
              excludeEnd: true,
              excludeBegin: true,
              relevance: 0
            },
            {
              className: "variable",
              begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
              endsParent: true,
              relevance: 0
            },
            // eat spaces (not newlines) so we can find
            // types or variables
            {
              begin: /(?=[^\n])\s/,
              relevance: 0
            }
          ]
        }
      ]
    }
  );
  const COMMENT = {
    className: "comment",
    variants: [
      JSDOC_COMMENT,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE
    ]
  };
  const SUBST_INTERNALS = [
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE,
    HTML_TEMPLATE,
    CSS_TEMPLATE,
    GRAPHQL_TEMPLATE,
    TEMPLATE_STRING,
    // Skip numbers when they are part of a variable name
    { match: /\$\d+/ },
    NUMBER
    // This is intentional:
    // See https://github.com/highlightjs/highlight.js/issues/3288
    // hljs.REGEXP_MODE
  ];
  SUBST.contains = SUBST_INTERNALS.concat({
    // we need to pair up {} inside our subst to prevent
    // it from ending too early by matching another }
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS$1,
    contains: [
      "self"
    ].concat(SUBST_INTERNALS)
  });
  const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
  const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
    // eat recursive parens in sub expressions
    {
      begin: /(\s*)\(/,
      end: /\)/,
      keywords: KEYWORDS$1,
      contains: ["self"].concat(SUBST_AND_COMMENTS)
    }
  ]);
  const PARAMS = {
    className: "params",
    // convert this to negative lookbehind in v12
    begin: /(\s*)\(/,
    // to match the parms with
    end: /\)/,
    excludeBegin: true,
    excludeEnd: true,
    keywords: KEYWORDS$1,
    contains: PARAMS_CONTAINS
  };
  const CLASS_OR_EXTENDS = {
    variants: [
      // class Car extends vehicle
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1,
          /\s+/,
          /extends/,
          /\s+/,
          regex.concat(IDENT_RE$1, "(", regex.concat(/\./, IDENT_RE$1), ")*")
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          5: "keyword",
          7: "title.class.inherited"
        }
      },
      // class Car
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      }
    ]
  };
  const CLASS_REFERENCE = {
    relevance: 0,
    match: regex.either(
      // Hard coded exceptions
      /\bJSON/,
      // Float32Array, OutT
      /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
      // CSSFactory, CSSFactoryT
      /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
      // FPs, FPsT
      /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
      // P
      // single letters are not highlighted
      // BLAH
      // this will be flagged as a UPPER_CASE_CONSTANT instead
    ),
    className: "title.class",
    keywords: {
      _: [
        // se we still get relevance credit for JS library classes
        ...TYPES2,
        ...ERROR_TYPES2
      ]
    }
  };
  const USE_STRICT = {
    label: "use_strict",
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use (strict|asm)['"]/
  };
  const FUNCTION_DEFINITION = {
    variants: [
      {
        match: [
          /function/,
          /\s+/,
          IDENT_RE$1,
          /(?=\s*\()/
        ]
      },
      // anonymous function
      {
        match: [
          /function/,
          /\s*(?=\()/
        ]
      }
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    label: "func.def",
    contains: [PARAMS],
    illegal: /%/
  };
  const UPPER_CASE_CONSTANT = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  function noneOf(list) {
    return regex.concat("(?!", list.join("|"), ")");
  }
  const FUNCTION_CALL = {
    match: regex.concat(
      /\b/,
      noneOf([
        ...BUILT_IN_GLOBALS2,
        "super",
        "import",
        "await"
      ].map((x) => `${x}\\s*\\(`)),
      IDENT_RE$1,
      regex.lookahead(/\s*\(/)
    ),
    className: "title.function",
    relevance: 0
  };
  const PROPERTY_ACCESS = {
    begin: regex.concat(/\./, regex.lookahead(
      regex.concat(IDENT_RE$1, /(?![0-9A-Za-z$_(])/)
    )),
    end: IDENT_RE$1,
    excludeBegin: true,
    keywords: "prototype",
    className: "property",
    relevance: 0
  };
  const GETTER_OR_SETTER = {
    match: [
      /get|set/,
      /\s+/,
      IDENT_RE$1,
      /(?=\()/
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      {
        // eat to avoid empty params
        begin: /\(\)/
      },
      PARAMS
    ]
  };
  const FUNC_LEAD_IN_RE = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs.UNDERSCORE_IDENT_RE + ")\\s*=>";
  const FUNCTION_VARIABLE = {
    match: [
      /const|var|let/,
      /\s+/,
      IDENT_RE$1,
      /\s*/,
      /=\s*/,
      /(async\s*)?/,
      // async is optional
      regex.lookahead(FUNC_LEAD_IN_RE)
    ],
    keywords: "async",
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      PARAMS
    ]
  };
  return {
    name: "JavaScript",
    aliases: ["js", "jsx", "mjs", "cjs"],
    keywords: KEYWORDS$1,
    // this will be extended by TypeScript
    exports: { PARAMS_CONTAINS, CLASS_REFERENCE },
    illegal: /#(?![$_A-Za-z])/,
    contains: [
      hljs.SHEBANG({
        label: "shebang",
        binary: "node",
        relevance: 5
      }),
      USE_STRICT,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      HTML_TEMPLATE,
      CSS_TEMPLATE,
      GRAPHQL_TEMPLATE,
      TEMPLATE_STRING,
      COMMENT,
      // Skip numbers when they are part of a variable name
      { match: /\$\d+/ },
      NUMBER,
      CLASS_REFERENCE,
      {
        scope: "attr",
        match: IDENT_RE$1 + regex.lookahead(":"),
        relevance: 0
      },
      FUNCTION_VARIABLE,
      {
        // "value" container
        begin: "(" + hljs.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
        keywords: "return throw case",
        relevance: 0,
        contains: [
          COMMENT,
          hljs.REGEXP_MODE,
          {
            className: "function",
            // we have to count the parens to make sure we actually have the
            // correct bounding ( ) before the =>.  There could be any number of
            // sub-expressions inside also surrounded by parens.
            begin: FUNC_LEAD_IN_RE,
            returnBegin: true,
            end: "\\s*=>",
            contains: [
              {
                className: "params",
                variants: [
                  {
                    begin: hljs.UNDERSCORE_IDENT_RE,
                    relevance: 0
                  },
                  {
                    className: null,
                    begin: /\(\s*\)/,
                    skip: true
                  },
                  {
                    begin: /(\s*)\(/,
                    end: /\)/,
                    excludeBegin: true,
                    excludeEnd: true,
                    keywords: KEYWORDS$1,
                    contains: PARAMS_CONTAINS
                  }
                ]
              }
            ]
          },
          {
            // could be a comma delimited list of params to a function call
            begin: /,/,
            relevance: 0
          },
          {
            match: /\s+/,
            relevance: 0
          },
          {
            // JSX
            variants: [
              { begin: FRAGMENT.begin, end: FRAGMENT.end },
              { match: XML_SELF_CLOSING },
              {
                begin: XML_TAG.begin,
                // we carefully check the opening tag to see if it truly
                // is a tag and not a false positive
                "on:begin": XML_TAG.isTrulyOpeningTag,
                end: XML_TAG.end
              }
            ],
            subLanguage: "xml",
            contains: [
              {
                begin: XML_TAG.begin,
                end: XML_TAG.end,
                skip: true,
                contains: ["self"]
              }
            ]
          }
        ]
      },
      FUNCTION_DEFINITION,
      {
        // prevent this from getting swallowed up by function
        // since they appear "function like"
        beginKeywords: "while if switch catch for"
      },
      {
        // we have to count the parens to make sure we actually have the correct
        // bounding ( ).  There could be any number of sub-expressions inside
        // also surrounded by parens.
        begin: "\\b(?!function)" + hljs.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
        // end parens
        returnBegin: true,
        label: "func.def",
        contains: [
          PARAMS,
          hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1, className: "title.function" })
        ]
      },
      // catch ... so it won't trigger the property rule below
      {
        match: /\.\.\./,
        relevance: 0
      },
      PROPERTY_ACCESS,
      // hack: prevents detection of keywords in some circumstances
      // .keyword()
      // $keyword = x
      {
        match: "\\$" + IDENT_RE$1,
        relevance: 0
      },
      {
        match: [/\bconstructor(?=\s*\()/],
        className: { 1: "title.function" },
        contains: [PARAMS]
      },
      FUNCTION_CALL,
      UPPER_CASE_CONSTANT,
      CLASS_OR_EXTENDS,
      GETTER_OR_SETTER,
      {
        match: /\$[(.]/
        // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
      }
    ]
  };
}
function typescript(hljs) {
  const regex = hljs.regex;
  const tsLanguage = javascript2(hljs);
  const IDENT_RE$1 = IDENT_RE2;
  const TYPES3 = [
    "any",
    "void",
    "number",
    "boolean",
    "string",
    "object",
    "never",
    "symbol",
    "bigint",
    "unknown"
  ];
  const NAMESPACE = {
    begin: [
      /namespace/,
      /\s+/,
      hljs.IDENT_RE
    ],
    beginScope: {
      1: "keyword",
      3: "title.class"
    }
  };
  const INTERFACE = {
    beginKeywords: "interface",
    end: /\{/,
    excludeEnd: true,
    keywords: {
      keyword: "interface extends",
      built_in: TYPES3
    },
    contains: [tsLanguage.exports.CLASS_REFERENCE]
  };
  const USE_STRICT = {
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use strict['"]/
  };
  const TS_SPECIFIC_KEYWORDS = [
    "type",
    // "namespace",
    "interface",
    "public",
    "private",
    "protected",
    "implements",
    "declare",
    "abstract",
    "readonly",
    "enum",
    "override",
    "satisfies"
  ];
  const KEYWORDS$1 = {
    $pattern: IDENT_RE2,
    keyword: KEYWORDS2.concat(TS_SPECIFIC_KEYWORDS),
    literal: LITERALS2,
    built_in: BUILT_INS2.concat(TYPES3),
    "variable.language": BUILT_IN_VARIABLES2
  };
  const DECORATOR = {
    className: "meta",
    begin: "@" + IDENT_RE$1
  };
  const swapMode = (mode, label, replacement) => {
    const indx = mode.contains.findIndex((m) => m.label === label);
    if (indx === -1) {
      throw new Error("can not find mode to replace");
    }
    mode.contains.splice(indx, 1, replacement);
  };
  Object.assign(tsLanguage.keywords, KEYWORDS$1);
  tsLanguage.exports.PARAMS_CONTAINS.push(DECORATOR);
  const ATTRIBUTE_HIGHLIGHT = tsLanguage.contains.find((c2) => c2.scope === "attr");
  const OPTIONAL_KEY_OR_ARGUMENT = Object.assign(
    {},
    ATTRIBUTE_HIGHLIGHT,
    { match: regex.concat(IDENT_RE$1, regex.lookahead(/\s*\?:/)) }
  );
  tsLanguage.exports.PARAMS_CONTAINS.push([
    tsLanguage.exports.CLASS_REFERENCE,
    // class reference for highlighting the params types
    ATTRIBUTE_HIGHLIGHT,
    // highlight the params key
    OPTIONAL_KEY_OR_ARGUMENT
    // Added for optional property assignment highlighting
  ]);
  tsLanguage.contains = tsLanguage.contains.concat([
    DECORATOR,
    NAMESPACE,
    INTERFACE,
    OPTIONAL_KEY_OR_ARGUMENT
    // Added for optional property assignment highlighting
  ]);
  swapMode(tsLanguage, "shebang", hljs.SHEBANG());
  swapMode(tsLanguage, "use_strict", USE_STRICT);
  const functionDeclaration = tsLanguage.contains.find((m) => m.label === "func.def");
  functionDeclaration.relevance = 0;
  Object.assign(tsLanguage, {
    name: "TypeScript",
    aliases: [
      "ts",
      "tsx",
      "mts",
      "cts"
    ]
  });
  return tsLanguage;
}

// node_modules/highlight.js/es/languages/xml.js
function xml(hljs) {
  const regex = hljs.regex;
  const TAG_NAME_RE = regex.concat(/[\p{L}_]/u, regex.optional(/[\p{L}0-9_.-]*:/u), /[\p{L}0-9_.-]*/u);
  const XML_IDENT_RE = /[\p{L}0-9._:-]+/u;
  const XML_ENTITIES = {
    className: "symbol",
    begin: /&[a-z]+;|&#[0-9]+;|&#x[a-f0-9]+;/
  };
  const XML_META_KEYWORDS = {
    begin: /\s/,
    contains: [
      {
        className: "keyword",
        begin: /#?[a-z_][a-z1-9_-]+/,
        illegal: /\n/
      }
    ]
  };
  const XML_META_PAR_KEYWORDS = hljs.inherit(XML_META_KEYWORDS, {
    begin: /\(/,
    end: /\)/
  });
  const APOS_META_STRING_MODE = hljs.inherit(hljs.APOS_STRING_MODE, { className: "string" });
  const QUOTE_META_STRING_MODE = hljs.inherit(hljs.QUOTE_STRING_MODE, { className: "string" });
  const TAG_INTERNALS = {
    endsWithParent: true,
    illegal: /</,
    relevance: 0,
    contains: [
      {
        className: "attr",
        begin: XML_IDENT_RE,
        relevance: 0
      },
      {
        begin: /=\s*/,
        relevance: 0,
        contains: [
          {
            className: "string",
            endsParent: true,
            variants: [
              {
                begin: /"/,
                end: /"/,
                contains: [XML_ENTITIES]
              },
              {
                begin: /'/,
                end: /'/,
                contains: [XML_ENTITIES]
              },
              { begin: /[^\s"'=<>`]+/ }
            ]
          }
        ]
      }
    ]
  };
  return {
    name: "HTML, XML",
    aliases: [
      "html",
      "xhtml",
      "rss",
      "atom",
      "xjb",
      "xsd",
      "xsl",
      "plist",
      "wsf",
      "svg"
    ],
    case_insensitive: true,
    unicodeRegex: true,
    contains: [
      {
        className: "meta",
        begin: /<![a-z]/,
        end: />/,
        relevance: 10,
        contains: [
          XML_META_KEYWORDS,
          QUOTE_META_STRING_MODE,
          APOS_META_STRING_MODE,
          XML_META_PAR_KEYWORDS,
          {
            begin: /\[/,
            end: /\]/,
            contains: [
              {
                className: "meta",
                begin: /<![a-z]/,
                end: />/,
                contains: [
                  XML_META_KEYWORDS,
                  XML_META_PAR_KEYWORDS,
                  QUOTE_META_STRING_MODE,
                  APOS_META_STRING_MODE
                ]
              }
            ]
          }
        ]
      },
      hljs.COMMENT(
        /<!--/,
        /-->/,
        { relevance: 10 }
      ),
      {
        begin: /<!\[CDATA\[/,
        end: /\]\]>/,
        relevance: 10
      },
      XML_ENTITIES,
      // xml processing instructions
      {
        className: "meta",
        end: /\?>/,
        variants: [
          {
            begin: /<\?xml/,
            relevance: 10,
            contains: [
              QUOTE_META_STRING_MODE
            ]
          },
          {
            begin: /<\?[a-z][a-z0-9]+/
          }
        ]
      },
      {
        className: "tag",
        /*
        The lookahead pattern (?=...) ensures that 'begin' only matches
        '<style' as a single word, followed by a whitespace or an
        ending bracket.
        */
        begin: /<style(?=\s|>)/,
        end: />/,
        keywords: { name: "style" },
        contains: [TAG_INTERNALS],
        starts: {
          end: /<\/style>/,
          returnEnd: true,
          subLanguage: "css"
        }
      },
      {
        className: "tag",
        // See the comment in the <style tag about the lookahead pattern
        begin: /<script(?=\s|>)/,
        end: />/,
        keywords: { name: "script" },
        contains: [TAG_INTERNALS],
        starts: {
          end: /<\/script>/,
          returnEnd: true,
          subLanguage: "javascript"
        }
      },
      // we need this for now for jSX
      {
        className: "tag",
        begin: /<>|<\/>/
      },
      // open tag
      {
        className: "tag",
        begin: regex.concat(
          /</,
          regex.lookahead(regex.concat(
            TAG_NAME_RE,
            // <tag/>
            // <tag>
            // <tag ...
            regex.either(/\/>/, />/, /\s/)
          ))
        ),
        end: /\/?>/,
        contains: [
          {
            className: "name",
            begin: TAG_NAME_RE,
            relevance: 0,
            starts: TAG_INTERNALS
          }
        ]
      },
      // close tag
      {
        className: "tag",
        begin: regex.concat(
          /<\//,
          regex.lookahead(regex.concat(
            TAG_NAME_RE,
            />/
          ))
        ),
        contains: [
          {
            className: "name",
            begin: TAG_NAME_RE,
            relevance: 0
          },
          {
            begin: />/,
            relevance: 0,
            endsParent: true
          }
        ]
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/yaml.js
function yaml(hljs) {
  const LITERALS3 = "true false yes no null";
  const URI_CHARACTERS = "[\\w#;/?:@&=+$,.~*'()[\\]]+";
  const KEY = {
    className: "attr",
    variants: [
      // added brackets support and special char support
      { begin: /[\w*@][\w*@ :()\./-]*:(?=[ \t]|$)/ },
      {
        // double quoted keys - with brackets and special char support
        begin: /"[\w*@][\w*@ :()\./-]*":(?=[ \t]|$)/
      },
      {
        // single quoted keys - with brackets and special char support
        begin: /'[\w*@][\w*@ :()\./-]*':(?=[ \t]|$)/
      }
    ]
  };
  const TEMPLATE_VARIABLES = {
    className: "template-variable",
    variants: [
      {
        // jinja templates Ansible
        begin: /\{\{/,
        end: /\}\}/
      },
      {
        // Ruby i18n
        begin: /%\{/,
        end: /\}/
      }
    ]
  };
  const SINGLE_QUOTE_STRING = {
    className: "string",
    relevance: 0,
    begin: /'/,
    end: /'/,
    contains: [
      {
        match: /''/,
        scope: "char.escape",
        relevance: 0
      }
    ]
  };
  const STRING = {
    className: "string",
    relevance: 0,
    variants: [
      {
        begin: /"/,
        end: /"/
      },
      { begin: /\S+/ }
    ],
    contains: [
      hljs.BACKSLASH_ESCAPE,
      TEMPLATE_VARIABLES
    ]
  };
  const CONTAINER_STRING = hljs.inherit(STRING, { variants: [
    {
      begin: /'/,
      end: /'/,
      contains: [
        {
          begin: /''/,
          relevance: 0
        }
      ]
    },
    {
      begin: /"/,
      end: /"/
    },
    { begin: /[^\s,{}[\]]+/ }
  ] });
  const DATE_RE = "[0-9]{4}(-[0-9][0-9]){0,2}";
  const TIME_RE = "([Tt \\t][0-9][0-9]?(:[0-9][0-9]){2})?";
  const FRACTION_RE = "(\\.[0-9]*)?";
  const ZONE_RE = "([ \\t])*(Z|[-+][0-9][0-9]?(:[0-9][0-9])?)?";
  const TIMESTAMP = {
    className: "number",
    begin: "\\b" + DATE_RE + TIME_RE + FRACTION_RE + ZONE_RE + "\\b"
  };
  const VALUE_CONTAINER = {
    end: ",",
    endsWithParent: true,
    excludeEnd: true,
    keywords: LITERALS3,
    relevance: 0
  };
  const OBJECT = {
    begin: /\{/,
    end: /\}/,
    contains: [VALUE_CONTAINER],
    illegal: "\\n",
    relevance: 0
  };
  const ARRAY = {
    begin: "\\[",
    end: "\\]",
    contains: [VALUE_CONTAINER],
    illegal: "\\n",
    relevance: 0
  };
  const MODES4 = [
    KEY,
    {
      className: "meta",
      begin: "^---\\s*$",
      relevance: 10
    },
    {
      // multi line string
      // Blocks start with a | or > followed by a newline
      //
      // Indentation of subsequent lines must be the same to
      // be considered part of the block
      className: "string",
      begin: "[\\|>]([1-9]?[+-])?[ ]*\\n( +)[^ ][^\\n]*\\n(\\2[^\\n]+\\n?)*"
    },
    {
      // Ruby/Rails erb
      begin: "<%[%=-]?",
      end: "[%-]?%>",
      subLanguage: "ruby",
      excludeBegin: true,
      excludeEnd: true,
      relevance: 0
    },
    {
      // named tags
      className: "type",
      begin: "!\\w+!" + URI_CHARACTERS
    },
    // https://yaml.org/spec/1.2/spec.html#id2784064
    {
      // verbatim tags
      className: "type",
      begin: "!<" + URI_CHARACTERS + ">"
    },
    {
      // primary tags
      className: "type",
      begin: "!" + URI_CHARACTERS
    },
    {
      // secondary tags
      className: "type",
      begin: "!!" + URI_CHARACTERS
    },
    {
      // fragment id &ref
      className: "meta",
      begin: "&" + hljs.UNDERSCORE_IDENT_RE + "$"
    },
    {
      // fragment reference *ref
      className: "meta",
      begin: "\\*" + hljs.UNDERSCORE_IDENT_RE + "$"
    },
    {
      // array listing
      className: "bullet",
      // TODO: remove |$ hack when we have proper look-ahead support
      begin: "-(?=[ ]|$)",
      relevance: 0
    },
    hljs.HASH_COMMENT_MODE,
    {
      beginKeywords: LITERALS3,
      keywords: { literal: LITERALS3 }
    },
    TIMESTAMP,
    // numbers are any valid C-style number that
    // sit isolated from other words
    {
      className: "number",
      begin: hljs.C_NUMBER_RE + "\\b",
      relevance: 0
    },
    OBJECT,
    ARRAY,
    SINGLE_QUOTE_STRING,
    STRING
  ];
  const VALUE_MODES = [...MODES4];
  VALUE_MODES.pop();
  VALUE_MODES.push(CONTAINER_STRING);
  VALUE_CONTAINER.contains = VALUE_MODES;
  return {
    name: "YAML",
    case_insensitive: true,
    aliases: ["yml"],
    contains: MODES4
  };
}

// src/lib/highlight.ts
var HLJS_LANGUAGES = [
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["csharp", csharp],
  ["css", css],
  ["diff", diff],
  ["dockerfile", dockerfile],
  ["go", go],
  ["graphql", graphql],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["kotlin", kotlin],
  ["less", less],
  ["lua", lua],
  ["makefile", makefile],
  ["markdown", markdown],
  ["nginx", nginx],
  ["objectivec", objectivec],
  ["perl", perl],
  ["php", php],
  ["plaintext", plaintext],
  ["python", python],
  ["ruby", ruby],
  ["rust", rust],
  ["scss", scss],
  ["shell", shell],
  ["sql", sql],
  ["swift", swift],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml]
];
var HLJS_BY_NAME = Object.fromEntries(HLJS_LANGUAGES);

// src/lib/fs.ts
var api = {
  getSidecarUrl: () => window.coder.getSidecarUrl(),
  probeSidecar: () => window.coder.probeSidecar(),
  getEnv: (key) => window.coder.getEnv(key),
  googleSignIn: (clientId, clientSecret, scope) => window.coder.googleSignIn(clientId, clientSecret, scope),
  selectFolder: () => window.coder.selectFolder(),
  selectFile: () => window.coder.selectFile(),
  importFile: (absPath) => window.coder.importFile(absPath),
  fsList: (root, rel) => window.coder.fsList(root, rel),
  fsWalk: (root) => window.coder.fsWalk(root),
  fsRead: (root, rel) => window.coder.fsRead(root, rel),
  fsWrite: (root, rel, content) => window.coder.fsWrite(root, rel, content),
  fsDelete: (root, rel) => window.coder.fsDelete(root, rel),
  fsCopy: (root, from, to) => window.coder.fsCopy(root, from, to),
  fsRename: (root, from, to) => window.coder.fsRename(root, from, to),
  coderList: (rel) => window.coder.coderList(rel),
  coderRead: (rel) => window.coder.coderRead(rel),
  coderWrite: (rel, content) => window.coder.coderWrite(rel, content),
  coderDelete: (rel) => window.coder.coderDelete(rel),
  searchContent: (root, query) => window.coder.searchContent(root, query),
  readImage: (absPath) => window.coder.readImage(absPath),
  readPdfBase64: (absPath) => window.coder.readPdfBase64(absPath),
  normalizeImage: (absPath) => window.coder.normalizeImage(absPath),
  captureScreen: () => window.coder.captureScreen(),
  computerPermissions: () => window.coder.computerPermissions(),
  requestScreenRecording: () => window.coder.requestScreenRecording(),
  getPathForFile: (file) => window.coder.getPathForFile(file),
  storeGet: (key) => window.coder.storeGet(key),
  storeSet: (key, value) => window.coder.storeSet(key, value),
  chatGet: (id) => window.coder.chatGet(id),
  getDataPath: () => window.coder.getDataPath(),
  hasSettingsFile: () => window.coder.hasSettingsFile(),
  moveDataPath: (p) => window.coder.moveDataPath(p),
  onSidecarChanged: (cb) => window.coder.onSidecarChanged(cb),
  onSidecarDead: (cb) => window.coder.onSidecarDead(cb),
  onFlushPersist: (cb) => window.coder.onFlushPersist(cb),
  flushPersistDone: () => window.coder.flushPersistDone(),
  onMigrateProgress: (cb) => window.coder.onMigrateProgress(cb),
  openFileExternal: async (absPath, editor) => {
    try {
      const fn = window.coder?.openFileExternal;
      if (typeof fn !== "function") {
        return { ok: false, error: "External open is unavailable (the desktop bridge is outdated \u2014 rebuild the app)." };
      }
      const res = await fn.call(window.coder, absPath, editor);
      if (res && typeof res.ok === "boolean") return res;
      return { ok: false, error: "External open is unavailable in this environment." };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  openWorkspaceFolder: async (dir) => {
    try {
      const fn = window.coder?.openWorkspaceFolder;
      if (typeof fn !== "function") {
        return { ok: false, error: "Reveal in file manager is unavailable (the desktop bridge is outdated \u2014 rebuild the app)." };
      }
      const res = await fn.call(window.coder, dir);
      if (res && typeof res.ok === "boolean") return res;
      return { ok: false, error: "Reveal in file manager is unavailable in this environment." };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  openWorkspaceTerminal: async (dir) => {
    try {
      const fn = window.coder?.openWorkspaceTerminal;
      if (typeof fn !== "function") {
        return { ok: false, error: "Terminal open is unavailable (the desktop bridge is outdated \u2014 rebuild the app)." };
      }
      const res = await fn.call(window.coder, dir);
      if (res && typeof res.ok === "boolean") return res;
      return { ok: false, error: "Terminal open is unavailable in this environment." };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
};

// src/lib/bidi.ts
var PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
var RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
var FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
var DIGITS_RE = `[0-9${FA_DIGITS}]`;
var LINE_RANGE_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)(?:\\s*[-\u2013\u2014~]\\s*(${DIGITS_RE}+))?`
);
var LINE_RANGE_CONN_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)\\s+(?:\u062A\u0627|\u0627\u0644\u06CC)\\s+(${DIGITS_RE}+)`
);
var PATH_RE = new RegExp(
  `((?:[\\w\\/\\\\-]+\\.)*[\\w\\/\\\\-]+\\.\\w+)(?=:?(?:${DIGITS_RE}+|$))(?::(${DIGITS_RE}+)(?:-(${DIGITS_RE}+))?)?`
);
var BARE_RANGE_FENCE_RE = new RegExp(
  "^```\\s*([\\w-]+):(" + DIGITS_RE + "+)-(" + DIGITS_RE + "+)\\s*$"
);
var MIXED_WORD_RE = new RegExp(
  `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
  "g"
);
var SCRIPT_BOUNDARY_RE = new RegExp(
  `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
  "g"
);

// src/lib/context.ts
var PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
function modelReasoning(provider, model) {
  if (!provider) return null;
  const manual = provider.manualReasoningMap ?? {};
  const directManual = manual[model];
  if (typeof directManual === "boolean") return directManual;
  const prefixedManual = manual[`${provider.id ?? ""}/${model}`];
  if (typeof prefixedManual === "boolean") return prefixedManual;
  const observed = provider.observedReasoningMap ?? {};
  const directObserved = observed[model];
  if (typeof directObserved === "boolean") return directObserved;
  const prefixedObserved = observed[`${provider.id ?? ""}/${model}`];
  if (typeof prefixedObserved === "boolean") return prefixedObserved;
  const map = provider.reasoningMap ?? {};
  const direct = map[model];
  if (typeof direct === "boolean") return direct;
  const prefixed = map[`${provider.id ?? ""}/${model}`];
  return typeof prefixed === "boolean" ? prefixed : null;
}

// src/lib/api.ts
var sidecarUrl = null;
var sidecarInFlight = null;
var SIDECAR_RESOLVE_TIMEOUT_MS = 1e4;
api.onSidecarChanged(() => {
  sidecarUrl = null;
  sidecarInFlight = null;
});
api.onSidecarDead(() => {
  sidecarUrl = null;
  sidecarInFlight = null;
});
async function isSidecarAlive(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
async function ensureSidecar() {
  if (sidecarInFlight) return sidecarInFlight;
  const p = (async () => {
    if (sidecarUrl) {
      if (await isSidecarAlive(sidecarUrl)) return sidecarUrl;
      sidecarUrl = null;
    }
    let timer;
    try {
      const url = await Promise.race([
        // The IPC itself can throw when the bridge is missing (a bare browser,
        // a harness without the preload) — and it throws SYNCHRONOUSLY, so a
        // bare `.catch()` would never attach. Wrapping it in a promise keeps
        // the contract below: this function never rejects, and a missing
        // bridge is just "no backend", which every caller already handles.
        Promise.resolve().then(() => api.getSidecarUrl()).catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), SIDECAR_RESOLVE_TIMEOUT_MS);
        })
      ]);
      if (url) sidecarUrl = url;
      return sidecarUrl;
    } finally {
      clearTimeout(timer);
    }
  })();
  sidecarInFlight = p;
  p.finally(() => {
    if (sidecarInFlight === p) sidecarInFlight = null;
  });
  return p;
}
function providerKeys(cfg) {
  const raw = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : [];
  const out = raw.filter((k) => typeof k === "string" && k.trim() !== "");
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim() !== "" && !out.includes(cfg.apiKey.trim())) out.push(cfg.apiKey.trim());
  return out;
}
async function pushSlotModel(slot, model) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/chat/slot_model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, model })
    });
  } catch {
  }
}
async function requestChatTitle(params) {
  const none = { title: null, usage: null };
  const url = await ensureSidecar();
  if (!url) {
    console.warn("[title] sidecar unreachable \u2014 keeping default chat title");
    return none;
  }
  try {
    const res = await fetch(`${url}/chats/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: params.provider.kind,
        provider_id: params.provider.id,
        api_keys: providerKeys(params.provider),
        base_url: params.provider.baseUrl,
        model: params.provider.model,
        subagent_models: params.subagentModels ?? {},
        subagent_thinking: params.subagentThinking ?? {},
        tool_fallbacks: params.toolFallbacks ?? {},
        providers: params.providers ?? {},
        model_reasoning: params.modelReasoning ?? false,
        text: params.text,
        chat_id: params.chatId ?? ""
      }),
      // Long budget so the backend fallback chain (title, compact, main)
      // fits inside one request; fire-and-forget so it never blocks the turn.
      signal: AbortSignal.timeout(9e4)
    });
    if (!res.ok) {
      console.warn(`[title] sidecar answered ${res.status} \u2014 keeping default chat title`);
      return none;
    }
    const data = await res.json().catch(() => ({}));
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) console.warn("[title] empty title reply \u2014 keeping default chat title");
    else console.info("[title] got title:", title, (params.chatId ?? "").slice(-6));
    return { title: title || null, usage: data.usage ?? null };
  } catch (err) {
    console.warn("[title] request failed \u2014 keeping default chat title", err);
    return none;
  }
}
async function listMcp() {
  const url = await ensureSidecar();
  if (!url) return { mcpServers: {}, builtins: [] };
  try {
    const res = await fetch(`${url}/plugins/mcp`);
    if (!res.ok) return { mcpServers: {}, builtins: [] };
    const data = await res.json();
    const out = {};
    for (const r of data.connectors ?? []) {
      if (!r.name || r.plugin_enabled === false) continue;
      out[r.name] = r.cfg ?? {};
    }
    return { mcpServers: out, builtins: [] };
  } catch {
    return { mcpServers: {}, builtins: [] };
  }
}
async function callMcpTool(tool, args, servers = {}) {
  const name = tool.trim();
  if (!name) return { error: "an MCP tool name is required" };
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const res = await fetch(`${url}/mcp/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: name, args, servers })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `mcp call failed (${res.status})` };
    return { result: data.result ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function saveMcp(name, cfg) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/plugins/mcp/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cfg })
    });
  } catch {
  }
}
async function deleteMcp(name) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/plugins/mcp/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
  } catch {
  }
}

// src/lib/artifacts.ts
async function getArtifact(chatId, id) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString();
    const res = await fetch(`${url}/artifacts/get?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` };
    if (!data.content) return { error: `artifact not found: ${id}` };
    return data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function getArtifactAssets(chatId, id) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString();
    const res = await fetch(`${url}/artifacts/assets?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` };
    return { files: data.files ?? [] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// node_modules/zustand/esm/vanilla.mjs
var import_meta = {};
var createStoreImpl = (createState) => {
  let state;
  const listeners = /* @__PURE__ */ new Set();
  const setState = (partial, replace) => {
    const nextState = typeof partial === "function" ? partial(state) : partial;
    if (!Object.is(nextState, state)) {
      const previousState = state;
      state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
      listeners.forEach((listener) => listener(state, previousState));
    }
  };
  const getState = () => state;
  const getInitialState = () => initialState;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const destroy = () => {
    if ((import_meta.env ? import_meta.env.MODE : void 0) !== "production") {
      console.warn(
        "[DEPRECATED] The `destroy` method will be unsupported in a future version. Instead use unsubscribe function returned by subscribe. Everything will be garbage-collected if store is garbage-collected."
      );
    }
    listeners.clear();
  };
  const api2 = { setState, getState, getInitialState, subscribe, destroy };
  const initialState = state = createState(setState, getState, api2);
  return api2;
};
var createStore = (createState) => createState ? createStoreImpl(createState) : createStoreImpl;

// node_modules/zustand/esm/index.mjs
var import_react = __toESM(require("react"), 1);
var import_with_selector = __toESM(require_with_selector(), 1);
var import_meta2 = {};
var { useDebugValue } = import_react.default;
var { useSyncExternalStoreWithSelector } = import_with_selector.default;
var didWarnAboutEqualityFn = false;
var identity = (arg) => arg;
function useStore(api2, selector = identity, equalityFn) {
  if ((import_meta2.env ? import_meta2.env.MODE : void 0) !== "production" && equalityFn && !didWarnAboutEqualityFn) {
    console.warn(
      "[DEPRECATED] Use `createWithEqualityFn` instead of `create` or use `useStoreWithEqualityFn` instead of `useStore`. They can be imported from 'zustand/traditional'. https://github.com/pmndrs/zustand/discussions/1937"
    );
    didWarnAboutEqualityFn = true;
  }
  const slice = useSyncExternalStoreWithSelector(
    api2.subscribe,
    api2.getState,
    api2.getServerState || api2.getInitialState,
    selector,
    equalityFn
  );
  useDebugValue(slice);
  return slice;
}
var createImpl = (createState) => {
  if ((import_meta2.env ? import_meta2.env.MODE : void 0) !== "production" && typeof createState !== "function") {
    console.warn(
      "[DEPRECATED] Passing a vanilla store will be unsupported in a future version. Instead use `import { useStore } from 'zustand'`."
    );
  }
  const api2 = typeof createState === "function" ? createStore(createState) : createState;
  const useBoundStore = (selector, equalityFn) => useStore(api2, selector, equalityFn);
  Object.assign(useBoundStore, api2);
  return useBoundStore;
};
var create = (createState) => createState ? createImpl(createState) : createImpl;

// src/lib/nvimTerminals.ts
var DEFAULT_NVIM_TERMINAL = "inapp";
var DEFAULT_TERMINAL_SHELL = "zsh";
function resolveNvimTerminal(_v) {
  return DEFAULT_NVIM_TERMINAL;
}

// src/lib/xtermTheme.ts
var DEFAULT_VIEWER_FONT_SIZE = 14;
var DEFAULT_TERMINAL_FONT_SIZE = 14;
function clampCodeFontSize(raw, fallback) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(24, Math.max(9, Math.round(raw)));
}
var liveScreens = /* @__PURE__ */ new Set();
function applyTerminalFontSize(px) {
  for (const s of liveScreens) {
    s.term.options.fontSize = px;
    s.refit();
  }
}

// src/lib/marketplaceDefaults.ts
function marketSourceKey(m) {
  return `${m.repo}\0${m.path ?? ""}\0${m.git_ref ?? ""}`;
}
var RETIRED_MARKETPLACES = ["anthropics/claude-plugins-official"];
function dropRetired(rows) {
  const gone = new Set(RETIRED_MARKETPLACES);
  return rows.filter((m) => {
    if (m.path || m.git_ref) return true;
    return !gone.has(m.repo.trim().toLowerCase());
  });
}
function mergeShippedMarketplaces(rows, shipped, fileVersion, currentVersion) {
  const kept = dropRetired(rows);
  if (fileVersion >= currentVersion) return kept;
  const fresh = dropRetired(shipped);
  const have = new Set(kept.map(marketSourceKey));
  const missing = fresh.filter((m) => !have.has(marketSourceKey(m)));
  return missing.length === 0 ? kept : [...kept, ...missing];
}

// src/lib/modes.ts
var BUILTIN_MODES = [
  {
    id: "ask",
    label: "Ask",
    icon: "chat",
    description: "Mentor mode: short, simple answers in plain words \u2014 which file, which line, what to change. Expands only when you ask for detail. Reads and inspects freely (files, shell, web); never writes.",
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
  },
  {
    id: "plan",
    label: "Plan",
    icon: "list",
    description: "Plans the work: a short, scannable step list naming the files it touches, for Build mode to execute. Reads and inspects freely; never writes.",
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
  },
  {
    id: "build",
    label: "Build",
    icon: "code",
    description: "Write and edit code, run commands. Full access to your project \u2014 the edit is the artifact, the reply is a short report of what changed.",
    capabilities: { readFiles: true, writeFiles: true, runTerminal: true, web: true }
  }
];
var BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id));
var FALLBACK_MODE = BUILTIN_MODES[0];
function normalizeMode(id) {
  if (id === "chat") return "ask";
  if (id === "codewriter") return "build";
  return id || "ask";
}

// src/lib/secrets.ts
var PREFIX = "enc:v1:";
var keyPromise = null;
function getKey() {
  if (!keyPromise) {
    const p = (async () => {
      try {
        const b64 = await window.coder.secretsGetKey();
        if (!b64) return null;
        const raw = Uint8Array.from(atob(b64), (c2) => c2.charCodeAt(0));
        return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      } catch {
        return null;
      }
    })();
    p.then((k) => {
      if (!k) keyPromise = null;
    }).catch(() => {
      keyPromise = null;
    });
    keyPromise = p;
  }
  return keyPromise;
}
var enc = new TextEncoder();
var dec = new TextDecoder();
function toB64(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function encryptSecret(plain) {
  if (!plain) return "";
  const k = await getKey();
  if (!k) throw new Error("encryption key unavailable \u2014 refusing to store secret in plaintext");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new Uint8Array(enc.encode(plain))));
  return `${PREFIX}${toB64(iv)}.${toB64(ct)}`;
}
async function decryptSecret(val) {
  if (!val || !val.startsWith(PREFIX)) return val;
  const k = await getKey();
  if (!k) return "";
  try {
    const body = val.slice(PREFIX.length);
    const sep = body.indexOf(".");
    const iv = fromB64(body.slice(0, sep));
    const ct = fromB64(body.slice(sep + 1));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ct);
    return dec.decode(pt);
  } catch {
    return "";
  }
}
async function encryptKeyList(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  for (const k of keys) {
    if (typeof k !== "string" || !k) continue;
    out.push(await encryptSecret(k));
  }
  return out;
}
async function decryptKeyList(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  for (const k of keys) {
    if (typeof k !== "string" || !k) continue;
    const d = await decryptSecret(k);
    if (d) out.push(d);
  }
  return out;
}
async function encryptProvider(p) {
  const out = { ...p };
  out.apiKeys = await encryptKeyList(p.apiKeys);
  const legacy = p.apiKey;
  if (out.apiKeys.length === 0 && typeof legacy === "string" && legacy) {
    out.apiKeys = [await encryptSecret(legacy)];
  }
  delete out.apiKey;
  return out;
}
async function decryptProvider(p) {
  const out = { ...p };
  out.apiKeys = await decryptKeyList(p.apiKeys);
  const legacy = p.apiKey;
  if (out.apiKeys.length === 0 && typeof legacy === "string" && legacy) {
    const d = await decryptSecret(legacy);
    if (d) out.apiKeys = [d];
  }
  delete out.apiKey;
  return out;
}
async function encryptSettings(raw) {
  const providers = Array.isArray(raw.providers) ? await Promise.all(raw.providers.map(encryptProvider)) : raw.providers;
  const searchConsole = raw.searchConsole ? {
    ...raw.searchConsole,
    clientId: await encryptSecret(raw.searchConsole.clientId || ""),
    clientSecret: await encryptSecret(raw.searchConsole.clientSecret || ""),
    refreshToken: await encryptSecret(raw.searchConsole.refreshToken || "")
  } : raw.searchConsole;
  const searchPlugins = Array.isArray(raw.searchPlugins) ? await Promise.all(
    raw.searchPlugins.map(async (p) => ({ ...p, apiKey: await encryptSecret(p.apiKey || "") }))
  ) : raw.searchPlugins;
  return { ...raw, providers, searchConsole, searchPlugins };
}
async function decryptSettings(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const providers = Array.isArray(raw.providers) ? await Promise.all(raw.providers.map(decryptProvider)) : raw.providers;
  const searchConsole = raw.searchConsole ? {
    ...raw.searchConsole,
    clientId: await decryptSecret(raw.searchConsole.clientId || ""),
    clientSecret: await decryptSecret(raw.searchConsole.clientSecret || ""),
    refreshToken: await decryptSecret(raw.searchConsole.refreshToken || "")
  } : raw.searchConsole;
  const searchPlugins = Array.isArray(raw.searchPlugins) ? await Promise.all(
    raw.searchPlugins.map(async (p) => ({ ...p, apiKey: await decryptSecret(p.apiKey || "") }))
  ) : raw.searchPlugins;
  const provider = raw.provider ? await decryptProvider(raw.provider) : raw.provider;
  return { ...raw, providers, searchConsole, searchPlugins, provider };
}

// src/lib/provider-meta.ts
var PROVIDER_META = {
  openrouter: {
    kind: "openrouter",
    label: "OpenRouter",
    name: "OpenRouter",
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://openrouter.ai/api/v1",
    defaultBaseUrl: "https://openrouter.ai/api/v1"
  },
  google: {
    kind: "google",
    label: "Google",
    name: "Google",
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlDesc: "Gemini models via Google.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  },
  nvidia: {
    kind: "nvidia",
    label: "NVIDIA",
    name: "NVIDIA",
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://integrate.api.nvidia.com/v1",
    baseUrlDesc: "NVIDIA NIM hosted models.",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1"
  },
  cloudflare: {
    kind: "cloudflare",
    label: "Cloudflare",
    name: "Cloudflare",
    requiresKey: true,
    builtin: true,
    // The catalog and the chat endpoint are both account-scoped, so the account
    // id has to come from the user. It has its OWN field (`accountId`) and the
    // base URL is built from this template — the row used to carry a read-only
    // hint holding the literal template, which no user could ever fill in, so
    // every request died on "missing account id".
    accountScopedBaseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
    accountIdHint: "Cloudflare dashboard \u2192 Workers & Pages \u2192 Account ID. The endpoint is built from it.",
    baseUrlDesc: "Workers AI.",
    extraHint: "The token needs Workers AI read access."
  },
  ollama: {
    kind: "ollama",
    label: "local",
    name: "local",
    requiresKey: false,
    builtin: true,
    local: true,
    editableBaseUrl: true
  },
  custom: {
    kind: "custom",
    label: "Custom API",
    name: "Custom API",
    requiresKey: false,
    builtin: false,
    editableBaseUrl: true,
    manualContextInput: true
  },
  anthropic: {
    kind: "anthropic",
    label: "Anthropic-compatible",
    name: "Anthropic",
    requiresKey: true,
    builtin: false,
    editableBaseUrl: true,
    baseUrlHint: "https://api.anthropic.com",
    baseUrlDesc: "Native Anthropic protocol (/v1/messages, x-api-key). Works with any Anthropic-compatible gateway."
  }
};
function providerMeta(kind) {
  return PROVIDER_META[kind ?? "custom"] ?? PROVIDER_META.custom;
}
function accountScopedBaseUrl(kind, accountId) {
  const template = providerMeta(kind).accountScopedBaseUrl;
  if (!template) return void 0;
  const id = accountIdFromBase(accountId).trim() || (accountId ?? "").trim();
  if (!id || /[/\\?&#{}\s]/.test(id)) return "";
  return template.replace("{account}", id);
}
function accountIdFromBase(url) {
  const raw = (url ?? "").trim();
  const at = raw.toLowerCase().indexOf("/accounts/");
  if (at < 0) return "";
  const seg = raw.slice(at + "/accounts/".length).split(/[/?#]/)[0].trim();
  return seg.includes("{") ? "" : seg;
}
var FOREIGN_PROVIDER_PREFIXES = /* @__PURE__ */ new Set([
  ...Object.keys(PROVIDER_META),
  "opencode"
]);

// src/lib/themes.ts
var DEFAULT_THEME = "rose-pine";

// src/lib/usage.ts
function normalizeUsageEntry(raw, chatProviderId, providerIds = []) {
  if (!raw || typeof raw !== "object") return void 0;
  if (Array.isArray(raw.entries)) {
    return raw;
  }
  const legacy = raw;
  const entries = [];
  for (const [key, v] of Object.entries(legacy)) {
    if (!v || typeof v !== "object") continue;
    const slash = key.indexOf("/");
    let providerId = chatProviderId;
    let model = key;
    if (slash > 0) {
      const prefix = key.slice(0, slash);
      if (prefix === chatProviderId) {
        model = key.slice(slash + 1);
      }
    }
    entries.push({
      providerId,
      model: normalizeUsageModel(providerId, model),
      input: v.input ?? 0,
      output: v.output ?? 0,
      cacheRead: v.cacheRead ?? 0,
      cacheWrite: v.cacheWrite ?? 0,
      lastUsed: v.lastUsed
    });
  }
  return { entries };
}
function normalizeUsageModel(providerId, model) {
  const m = (model || "").trim() || "main";
  if (m.includes("/")) {
    const prefix = m.slice(0, m.indexOf("/"));
    if (prefix === providerId) return m.slice(m.indexOf("/") + 1);
  }
  return m;
}

// src/lib/thinking.ts
var REASONING_PATTERNS = [
  /\b(qwen3|qwq)\b/i,
  /deepseek[-_.]?(r1|v4|v3\.1)\b/i,
  /\b(o1|o3|o4)([-._-]|$)/i,
  /\bgpt[-_.]?5/i,
  /\breason(er|ing)?\b/i,
  /\bthinking\b/i,
  /glm[-_.]?4\.(5|6)/i,
  /kimi[-_.]?k2[-_.]?thinking/i,
  /\bturbo[-_.]?reasoning/i,
  /\bexp\b.*\breason/i
];
function supportsReasoning(modelId, kind = "openrouter", reasoning) {
  const id = (modelId || "").trim();
  if (!id) return false;
  if (typeof reasoning === "boolean") return reasoning;
  return REASONING_PATTERNS.some((re) => re.test(id));
}

// src/lib/toolSlots.ts
var OTHER_SLOTS = ["compact", "web", "title"];
var TOOL_FALLBACK_SLOTS = ["explore", "vision", "schedule", ...OTHER_SLOTS];
var MAIN_MODEL_ENTRY = "main model";
function toolFallbackEntries(map) {
  const out = {};
  if (!map) return out;
  for (const slot of TOOL_FALLBACK_SLOTS) {
    const list = (map[slot] ?? []).map((r) => {
      const pid = r.providerId.trim();
      const model = r.model.trim();
      if (!pid && !model) return MAIN_MODEL_ENTRY;
      return `${pid}/${model}`;
    }).filter((entry) => !entry.startsWith("/") && !entry.endsWith("/"));
    if (list.length) out[slot] = list;
  }
  return out;
}
var MAIN_MODEL_ENTRIES = /* @__PURE__ */ new Set(["", "main", "main_model", "main model"]);
function isMainModelEntry(entry) {
  return MAIN_MODEL_ENTRIES.has((entry ?? "").trim().toLowerCase());
}
function otherSlotModel(models) {
  for (const key of OTHER_SLOTS) {
    const v = (models?.[key] ?? "").trim();
    if (!isMainModelEntry(v)) return v;
  }
  return "";
}
function withOtherSlotsFilled(models) {
  const out = { ...models ?? {} };
  const group = otherSlotModel(out);
  if (!group) return out;
  for (const key of OTHER_SLOTS) {
    if (isMainModelEntry(out[key])) out[key] = group;
  }
  return out;
}

// src/lib/toolActivity.ts
function normalizeToolName(tool) {
  const t = tool ?? "tool";
  return t === "task" || t === "subagent" ? "explore" : t;
}
function normalizeToolActivity(acts) {
  return acts.map((a) => {
    const out = a.tool === "explore" ? a : { ...a, tool: normalizeToolName(a.tool) };
    if (Array.isArray(out.children)) out.children = normalizeToolActivity(out.children);
    return out;
  });
}

// src/lib/chatTree.ts
var TREE_KEY = "coder:chatTree";
function nid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clampSize(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}
var CHAT_WINDOW_MAX = 6;
function makeLeaf(chatId, size = 1, id) {
  return { kind: "leaf", id: id ?? nid("leaf"), chatId, size: clampSize(size) };
}
function makeSplit(dir, children, size = 1, id) {
  return { kind: "split", id: id ?? nid("split"), dir, size: clampSize(size), children };
}
function dirForPos(pos) {
  if (pos === "left" || pos === "right") return "row";
  if (pos === "top" || pos === "bottom") return "col";
  return null;
}
function beforePos(pos) {
  return pos === "left" || pos === "top";
}
function bestSplitDir(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "row";
  return width >= height ? "row" : "col";
}
function collectChatIds(node) {
  if (!node) return [];
  if (node.kind === "leaf") return [node.chatId];
  const out = [];
  for (const c2 of node.children) out.push(...collectChatIds(c2));
  return out;
}
function leafCount(node) {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.children.reduce((n, c2) => n + leafCount(c2), 0);
}
function containsChat(node, chatId) {
  if (!node) return false;
  if (node.kind === "leaf") return node.chatId === chatId;
  return node.children.some((c2) => containsChat(c2, chatId));
}
function findLeafByChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? node : null;
  for (const c2 of node.children) {
    const hit = findLeafByChat(c2, chatId);
    if (hit) return hit;
  }
  return null;
}
function findParent(node, childId) {
  if (!node || node.kind !== "split") return null;
  for (const c2 of node.children) {
    if (c2.id === childId) return node;
    if (c2.kind === "split") {
      const hit = findParent(c2, childId);
      if (hit) return hit;
    }
  }
  return null;
}
function removeChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? null : node;
  const children = [];
  let changed = false;
  for (const c2 of node.children) {
    const next = removeChat(c2, chatId);
    if (next) children.push(next);
    if (next !== c2) changed = true;
  }
  if (!changed) return node;
  if (children.length === 0) return null;
  return { ...node, children };
}
function swapChats(node, a, b) {
  if (!node) return null;
  if (node.kind === "leaf") {
    if (node.chatId === a) return { ...node, chatId: b };
    if (node.chatId === b) return { ...node, chatId: a };
    return node;
  }
  let changed = false;
  const children = node.children.map((c2) => {
    const next = swapChats(c2, a, b) ?? c2;
    if (next !== c2) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function replaceChat(node, targetChatId, nextChatId) {
  if (node.kind === "leaf") {
    return node.chatId === targetChatId ? { ...node, chatId: nextChatId } : node;
  }
  let changed = false;
  const children = node.children.map((c2) => {
    const next = replaceChat(c2, targetChatId, nextChatId);
    if (next !== c2) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function normalizeTree(node, validIds, seen = /* @__PURE__ */ new Set()) {
  if (!node) return null;
  if (node.kind === "leaf") {
    if (!validIds.has(node.chatId) || seen.has(node.chatId)) return null;
    seen.add(node.chatId);
    const size = clampSize(node.size);
    return size === node.size ? node : { ...node, size };
  }
  const children = [];
  let changed = false;
  for (const c2 of node.children) {
    const next = normalizeTree(c2, validIds, seen);
    if (next) children.push(next);
    if (next !== c2) changed = true;
  }
  if (children.length === 0) return null;
  if (children.length === 1 && children[0].size !== 1) {
    children[0] = { ...children[0], size: 1 };
    changed = true;
  }
  if (!changed) return node;
  return { ...node, children };
}
function buildFromList(ids, dir, sizes) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (clean.length === 0) return null;
  if (clean.length === 1) return makeLeaf(clean[0], sizes?.[clean[0]] ?? 1);
  return makeSplit(
    dir,
    clean.map((chatId) => makeLeaf(chatId, sizes?.[chatId] ?? 1))
  );
}
function appendChat(node, chatId, dir) {
  if (!node) return makeLeaf(chatId);
  if (containsChat(node, chatId)) return node;
  if (leafCount(node) >= CHAT_WINDOW_MAX) return node;
  if (node.kind === "leaf") {
    return makeSplit(dir, [node, makeLeaf(chatId)]);
  }
  return { ...node, children: [...node.children, makeLeaf(chatId)] };
}
function openBeside(node, chatId, targetChatId, dir) {
  if (!node) return makeLeaf(chatId);
  if (containsChat(node, chatId)) return node;
  const fresh = makeLeaf(chatId);
  if (node.kind === "leaf") return makeSplit(dir, [node, fresh]);
  const target = findLeafByChat(node, targetChatId);
  if (!target) {
    if (node.dir === dir) return { ...node, children: [...node.children, fresh] };
    return makeSplit(dir, [node, fresh]);
  }
  const parent = findParent(node, target.id);
  if (parent && parent.dir === dir) {
    const idx = parent.children.findIndex((c2) => c2.id === target.id);
    const children = parent.children.slice();
    children.splice(idx + 1, 0, fresh);
    return replaceNode(node, parent.id, { ...parent, children });
  }
  return replaceNode(node, target.id, makeSplit(dir, [{ ...target }, fresh]));
}
function dropOnto(root, dragChatId, targetChatId, pos) {
  if (!dragChatId || !targetChatId) return root;
  if (dragChatId === targetChatId) return root;
  if (root && !containsChat(root, dragChatId) && leafCount(root) >= CHAT_WINDOW_MAX && pos !== "center") return root;
  if (pos === "center") {
    if (!root) return makeLeaf(dragChatId);
    if (containsChat(root, dragChatId)) return swapChats(root, dragChatId, targetChatId);
    if (!containsChat(root, targetChatId)) return appendChat(root, dragChatId, "col");
    return replaceChat(root, targetChatId, dragChatId);
  }
  const dirNeeded = dirForPos(pos);
  if (!dirNeeded) return root;
  const before = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const targetLeaf = findLeafByChat(root, targetChatId);
  if (dragLeaf && targetLeaf) {
    const pDrag = findParent(root, dragLeaf.id);
    const pTarget = findParent(root, targetLeaf.id);
    if (pDrag && pTarget && pDrag.id === pTarget.id && pDrag.dir === dirNeeded) {
      const rest = pTarget.children.filter((c2) => c2.id !== dragLeaf.id);
      let dest = rest.findIndex((c2) => c2.id === targetLeaf.id) + (before ? 0 : 1);
      dest = Math.max(0, Math.min(rest.length, dest));
      const reordered = rest.slice();
      reordered.splice(dest, 0, dragLeaf);
      return replaceNode(root, pTarget.id, { ...pTarget, children: reordered });
    }
  }
  const dragSize = dragLeaf?.size ?? 1;
  const base = containsChat(root, dragChatId) ? removeChat(root, dragChatId) : root;
  if (!base) return makeLeaf(dragChatId, dragSize);
  const target = findLeafByChat(base, targetChatId);
  if (!target) return appendChat(base, dragChatId, dirNeeded);
  const fresh = makeLeaf(dragChatId, dragSize);
  const parent = findParent(base, target.id);
  if (parent && parent.dir === dirNeeded) {
    const idx = parent.children.findIndex((c2) => c2.id === target.id);
    const children = parent.children.slice();
    children.splice(before ? idx : idx + 1, 0, fresh);
    return replaceNode(base, parent.id, { ...parent, children });
  }
  const split = makeSplit(
    dirNeeded,
    before ? [fresh, { ...target }] : [{ ...target }, fresh],
    target.size
  );
  split.children[0].size = 1;
  split.children[1].size = 1;
  return replaceNode(base, target.id, split);
}
function dropOntoRoot(root, dragChatId, pos) {
  if (!dragChatId) return root;
  const dirNeeded = dirForPos(pos);
  if (!dirNeeded) return root;
  const before = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const dragSize = dragLeaf?.size ?? 1;
  if (dragLeaf) {
    if (leafCount(root) <= 1) return root;
    const base = removeChat(root, dragChatId);
    if (!base) return makeLeaf(dragChatId, dragSize);
    const fresh2 = makeLeaf(dragChatId, dragSize);
    if (base.kind === "split" && base.dir === dirNeeded) {
      const children = before ? [fresh2, ...base.children] : [...base.children, fresh2];
      return { ...base, children };
    }
    return makeSplit(dirNeeded, before ? [fresh2, base] : [base, fresh2]);
  }
  if (leafCount(root) >= CHAT_WINDOW_MAX) return root;
  const fresh = makeLeaf(dragChatId);
  if (root.kind === "split" && root.dir === dirNeeded) {
    const children = before ? [fresh, ...root.children] : [...root.children, fresh];
    return { ...root, children };
  }
  return makeSplit(dirNeeded, before ? [fresh, root] : [root, fresh]);
}
function replaceNode(node, id, next) {
  if (node.id === id) return next;
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c2) => {
    const r = replaceNode(c2, id, next);
    if (r !== c2) changed = true;
    return r;
  });
  return changed ? { ...node, children } : node;
}
function setNodeSize(node, id, size) {
  if (!node) return null;
  if (node.id === id) return { ...node, size: clampSize(size) };
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c2) => {
    const next = setNodeSize(c2, id, size);
    if (next && next !== c2) changed = true;
    return next ?? c2;
  });
  return changed ? { ...node, children } : node;
}
function setChatSize(node, chatId, size) {
  const leaf = findLeafByChat(node, chatId);
  if (!leaf) return node;
  return setNodeSize(node, leaf.id, size);
}
function resizePair(node, parentId, firstId, secondId, firstSize, secondSize) {
  const step = setNodeSize(node, firstId, firstSize);
  return setNodeSize(step, secondId, secondSize);
}
function setRootDir(node, dir) {
  if (!node || node.kind !== "split") return node;
  if (node.dir === dir) return node;
  return { ...node, dir };
}
function sizesByChat(node) {
  const out = {};
  const walk = (n) => {
    if (!n) return;
    if (n.kind === "leaf") out[n.chatId] = clampSize(n.size);
    else n.children.forEach(walk);
  };
  walk(node);
  return out;
}
function loadChatTree() {
  try {
    const raw = localStorage.getItem(TREE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind !== "leaf" && parsed.kind !== "split") return null;
    return parsed;
  } catch {
    return null;
  }
}
function persistChatTree(tree) {
  try {
    if (!tree) localStorage.removeItem(TREE_KEY);
    else localStorage.setItem(TREE_KEY, JSON.stringify(tree));
  } catch {
  }
}
function toggleFullscreenId(current, target) {
  if (!target) return current;
  return current === target ? null : target;
}

// src/lib/store.ts
var MAX_SCHEDULE_RUNS_SEEN = 500;
function normalizeScheduleRunsSeen(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return [...new Set(out)].slice(-MAX_SCHEDULE_RUNS_SEEN);
}
var TITLE_MAX_WORDS = 4;
function capTitleWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, TITLE_MAX_WORDS).join(" ");
}
var uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
var MAX_COMPACTED_PER_CHAT = 50;
function capCompactedMessages(messages) {
  let overflow = 0;
  for (const m of messages) if (m.compacted) overflow++;
  if (overflow <= MAX_COMPACTED_PER_CHAT) return messages;
  overflow -= MAX_COMPACTED_PER_CHAT;
  const out = [];
  for (const m of messages) {
    if (m.compacted && overflow > 0) {
      overflow--;
      continue;
    }
    out.push(m);
  }
  return out;
}
var FORK_SEED_CHARS_PER_MESSAGE = 600;
var FORK_SEED_MAX_CHARS = 4e3;
function forkSeedLine(m) {
  const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Context";
  const flat = m.content.replace(/\s+/g, " ").trim();
  const body = flat.length > FORK_SEED_CHARS_PER_MESSAGE ? `${flat.slice(0, FORK_SEED_CHARS_PER_MESSAGE).trimEnd()}\u2026` : flat;
  return `${who}: ${body}`;
}
function forkSeedMessage(src, forkIndex) {
  const upto = src.messages.slice(0, forkIndex + 1).filter((m) => !m.compacted && !m.modeSwitch);
  const lines = [];
  let budget = FORK_SEED_MAX_CHARS;
  for (let i = upto.length - 1; i >= 0; i--) {
    const line = forkSeedLine(upto[i]);
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.unshift(line);
  }
  const body = lines.join("\n");
  const header = src.title && src.title !== "New chat" ? src.title : "Forked conversation";
  return {
    id: uid(),
    role: "system",
    content: `[Forked from \xAB${header}\xBB \u2014 compacted context up to the fork point]
` + (body || "(no earlier context)") + "\n[End of forked context \u2014 continue from here.]",
    // Deliberately NOT `compacted`: that flag means "folded into a summary, so
    // keep it OFF the wire" (isWireHistoryMessage), and this seed IS the wire
    // context the fork runs on. As a plain `system` message it travels like any
    // other system turn, and the send path sorts it to the FRONT of the history
    // — so the model reads it before the user's first new message.
    createdAt: Date.now()
  };
}
var QUEUED_SENT_GRACE_MS = 10 * 60 * 1e3;
function pruneQueued(queued, now = Date.now()) {
  if (!queued || queued.length === 0) return queued;
  const kept = queued.filter((q) => !q.sent || now - (q.createdAt ?? 0) < QUEUED_SENT_GRACE_MS);
  return kept.length === queued.length ? queued : kept;
}
function sanitizeChats(chats) {
  const out = [];
  const now = Date.now();
  for (const original of chats) {
    const pruned = pruneQueued(original.queued, now);
    const c2 = pruned === original.queued ? original : { ...original, queued: pruned };
    const hasBody = Array.isArray(c2.messages) && c2.messages.length > 0;
    if (c2.hydrated === false) {
      const { messages: _omitted, hydrated: _h, ...meta } = c2;
      out.push(meta);
      continue;
    }
    if (!hasBody) continue;
    const clean = { ...c2 };
    delete clean.pendingAsk;
    delete clean.pendingPermission;
    out.push({
      ...clean,
      messages: capCompactedMessages(c2.messages.map((m) => {
        const msg = { ...m };
        delete msg.retry;
        if (msg.streaming) msg.interrupted = true;
        delete msg.streaming;
        delete msg.thinking;
        delete msg.lspStatus;
        if (Array.isArray(msg.toolActivity)) {
          msg.toolActivity = trimToolActivity(msg.toolActivity);
        }
        if (Array.isArray(msg.images)) {
          msg.images = msg.images.map(trimPersistImageValue);
        }
        return msg;
      }))
    });
  }
  return out;
}
var MID_STREAM_MS = 2e3;
var lastMidStreamPersist = 0;
var MAX_TOOL_TEXT = 4e3;
var MAX_TOOL_ARG = 2e3;
var ANTROPIC_SKILLS_MARKETPLACE = {
  repo: "anthropics/skills",
  label: "Anthropic skills",
  kind: "skills"
};
var COMMUNITY_MARKETPLACE = {
  repo: "anthropics/claude-plugins-community",
  label: "Community",
  kind: "mcp"
};
var DEFAULT_MARKETPLACES = [
  ANTROPIC_SKILLS_MARKETPLACE,
  COMMUNITY_MARKETPLACE
];
var MARKETPLACE_DEFAULTS_VERSION = 4;
var MAX_PERSIST_IMAGE_CHARS = 1e5;
function trimPersistImageValue(v) {
  if (typeof v === "string") {
    if (v.length > MAX_PERSIST_IMAGE_CHARS && v.slice(0, 80).includes("base64")) {
      return v.slice(0, MAX_PERSIST_IMAGE_CHARS) + "\u2026";
    }
    return v;
  }
  if (v && typeof v === "object") {
    const o = v;
    for (const k of ["data", "dataUrl", "url", "content"]) {
      const s = o[k];
      if (typeof s === "string" && s.length > MAX_PERSIST_IMAGE_CHARS && (s.startsWith("data:") || s.slice(0, 80).includes("base64"))) {
        return { ...o, [k]: s.slice(0, MAX_PERSIST_IMAGE_CHARS) + "\u2026" };
      }
    }
  }
  return v;
}
function trimToolActivity(acts) {
  return acts.map((a) => {
    const out = { ...a };
    if (typeof out.summary === "string" && out.summary.length > MAX_TOOL_TEXT) {
      out.summary = out.summary.slice(0, MAX_TOOL_TEXT) + "\u2026";
    }
    if (typeof out.diff === "string" && out.diff.length > MAX_TOOL_TEXT) {
      out.diff = out.diff.slice(0, MAX_TOOL_TEXT) + "\u2026";
    }
    if (out.args && typeof out.args === "object") {
      const args = {};
      for (const [k, v] of Object.entries(out.args)) {
        args[k] = typeof v === "string" && v.length > MAX_TOOL_ARG ? v.slice(0, MAX_TOOL_ARG) + "\u2026" : v;
      }
      out.args = args;
    }
    if (Array.isArray(out.children)) out.children = trimToolActivity(out.children);
    return out;
  });
}
var MODE_LABELS = { ask: "Ask", plan: "Plan", build: "Build" };
var SEARCH_PLUGIN_LABELS = {
  duckduckgo: "DuckDuckGo",
  tavily: "Tavily"
};
function dedupeByKind(rows) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    out.push(r);
  }
  return out;
}
function migrateModePrompts(prompts) {
  const out = { ...prompts };
  if ("chat" in out && !("ask" in out)) {
    out.ask = out.chat;
    delete out.chat;
  }
  if ("codewriter" in out && !("build" in out)) {
    out.build = out.codewriter;
    delete out.codewriter;
  }
  if ("coder" in out) {
    delete out.coder;
  }
  return out;
}
var persistTimer;
function coercePositiveInt(v, fallback) {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
function coerceNonNegInt(v, fallback) {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}
function coerceBoundedInt(v, fallback, min, max) {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  return Math.max(min, Math.min(max, r));
}
function normalizeSttFallbacks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    if (!providerId) continue;
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    out.push({ providerId, model });
  }
  return out;
}
function normalizeToolFallbackRows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    out.push({ providerId, model });
  }
  return out;
}
function normalizeToolFallbacks(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [slot, list] of Object.entries(raw)) {
    if (!TOOL_FALLBACK_SLOTS.includes(slot)) continue;
    const rows = normalizeToolFallbackRows(list);
    if (rows.length) out[slot] = rows;
  }
  return out;
}
function normalizeTtsFallbacks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    if (!providerId) continue;
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    const voice = typeof rec.voice === "string" ? rec.voice.trim() : "";
    out.push({ providerId, model, voice });
  }
  return out;
}
var PERSIST_DEBOUNCE_MS = 100;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useStore2.getState().persist(), PERSIST_DEBOUNCE_MS);
}
var OPEN_CHATS_KEY = "coder:openChats";
var ACTIVE_CHAT_KEY = "coder:activeChat";
function persistOpenChats(ids) {
  try {
    localStorage.setItem(OPEN_CHATS_KEY, JSON.stringify(ids));
  } catch {
  }
}
function loadOpenChats() {
  try {
    const raw = localStorage.getItem(OPEN_CHATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}
function persistActiveChat(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_CHAT_KEY, id);
    else localStorage.removeItem(ACTIVE_CHAT_KEY);
  } catch {
  }
}
function loadActiveChat() {
  try {
    const raw = localStorage.getItem(ACTIVE_CHAT_KEY);
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}
function persistOpenState(ids, activeId) {
  persistOpenChats(ids);
  persistActiveChat(activeId);
}
var VISIBLE_CHATS_KEY = "coder:visibleChats";
var WINDOW_SIZES_KEY = "coder:chatWindowSizes";
function loadVisibleChats() {
  try {
    const raw = localStorage.getItem(VISIBLE_CHATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}
function persistVisibleChats(ids) {
  try {
    localStorage.setItem(VISIBLE_CHATS_KEY, JSON.stringify(ids));
  } catch {
  }
}
function loadWindowSizes() {
  try {
    const raw = localStorage.getItem(WINDOW_SIZES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = typeof v === "number" ? v : Number(v);
      if (k && Number.isFinite(n) && n > 0.1 && n < 10) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}
function persistWindowSizes(sizes) {
  try {
    localStorage.setItem(WINDOW_SIZES_KEY, JSON.stringify(sizes));
  } catch {
  }
}
function normalizeChatLayout(v) {
  return v === "horizontal" ? "horizontal" : "vertical";
}
var CHAT_LAYOUT_KEY = "coder:chatLayout";
function loadChatLayout() {
  try {
    return normalizeChatLayout(localStorage.getItem(CHAT_LAYOUT_KEY));
  } catch {
    return "vertical";
  }
}
function persistChatLayout(layout) {
  try {
    localStorage.setItem(CHAT_LAYOUT_KEY, layout);
  } catch {
  }
}
function normalizeVisibleChats(visible, validIds, activeId) {
  const out = [];
  for (const id of visible) {
    if (validIds.has(id) && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) {
    if (activeId && validIds.has(activeId)) return [activeId];
    const first = [...validIds][0];
    return first ? [first] : [];
  }
  return out;
}
function treeDirFromLayout(layout) {
  return layout === "horizontal" ? "row" : "col";
}
function smartAppendDir(fallback) {
  try {
    if (typeof document !== "undefined") {
      const rect = document.querySelector('[data-testid="chat-windows"]')?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) return bestSplitDir(rect.width, rect.height);
    }
    if (typeof window !== "undefined" && window.innerWidth > 0 && window.innerHeight > 0) {
      return bestSplitDir(Math.max(1, window.innerWidth - 320), window.innerHeight);
    }
  } catch {
  }
  return treeDirFromLayout(fallback);
}
function persistTreeMirrors(tree, fallbackLayout) {
  persistChatTree(tree);
  if (!tree) return { visibleChatIds: [], chatWindowSizes: {}, chatLayout: fallbackLayout };
  const visibleChatIds = collectChatIds(tree);
  const chatWindowSizes = sizesByChat(tree);
  const chatLayout = tree.kind === "split" ? tree.dir === "row" ? "horizontal" : "vertical" : fallbackLayout;
  persistVisibleChats(visibleChatIds);
  persistWindowSizes(chatWindowSizes);
  persistChatLayout(chatLayout);
  return { visibleChatIds, chatWindowSizes, chatLayout };
}
function ensureTree(tree, visible, layout) {
  if (tree && leafCount(tree) > 0) return tree;
  return buildFromList(visible, treeDirFromLayout(layout));
}
var CHAT_FULL_KEY = "coder:chatFull";
function loadChatFullscreen() {
  try {
    return localStorage.getItem(CHAT_FULL_KEY) === "1";
  } catch {
    return false;
  }
}
function persistChatFullscreen(v) {
  try {
    localStorage.setItem(CHAT_FULL_KEY, v ? "1" : "0");
  } catch {
  }
}
var WINDOW_FULL_KEY = "coder:windowFullscreen";
function loadWindowFullscreen() {
  try {
    const v = localStorage.getItem(WINDOW_FULL_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
function persistWindowFullscreen(id) {
  try {
    if (id) localStorage.setItem(WINDOW_FULL_KEY, id);
    else localStorage.removeItem(WINDOW_FULL_KEY);
  } catch {
  }
}
var TERMINAL_PANEL_KEY = "coder:terminalPanel";
function loadTerminalPanel() {
  try {
    return localStorage.getItem(TERMINAL_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}
function persistTerminalPanel(v) {
  try {
    localStorage.setItem(TERMINAL_PANEL_KEY, v ? "1" : "0");
  } catch {
  }
}
var TERMINAL_FULL_KEY = "coder:terminalFullscreen";
function loadTerminalFullscreen() {
  try {
    return localStorage.getItem(TERMINAL_FULL_KEY) === "1";
  } catch {
    return false;
  }
}
function persistTerminalFullscreen(v) {
  try {
    localStorage.setItem(TERMINAL_FULL_KEY, v ? "1" : "0");
  } catch {
  }
}
var TERMINAL_HEIGHT_KEY = "coder:terminalHeight";
var MIN_TERMINAL_HEIGHT = 140;
var DEFAULT_TERMINAL_HEIGHT = 300;
function clampTerminalHeight(px) {
  return Number.isFinite(px) ? Math.max(MIN_TERMINAL_HEIGHT, Math.round(px)) : DEFAULT_TERMINAL_HEIGHT;
}
function loadTerminalHeight() {
  try {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY);
    return raw === null ? DEFAULT_TERMINAL_HEIGHT : clampTerminalHeight(Number(raw));
  } catch {
    return DEFAULT_TERMINAL_HEIGHT;
  }
}
function persistTerminalHeight(px) {
  try {
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(px));
  } catch {
  }
}
var panelPersistTimer;
function persistPanelsSoon() {
  clearTimeout(panelPersistTimer);
  panelPersistTimer = setTimeout(() => {
    panelPersistTimer = void 0;
    void writeSettingsNow(useStore2.getState());
  }, PERSIST_DEBOUNCE_MS);
}
function writeChatsNow(s) {
  const streaming = s.chats.filter(
    (c2) => c2.hydrated !== false && c2.messages.some((m) => m.streaming)
  );
  const subset = streaming.length > 0 ? streaming : s.chats.filter((c2) => c2.id === s.activeChatId && c2.hydrated !== false);
  if (subset.length === 0) return;
  void api.storeSet("chats", sanitizeChats(subset));
}
function writeSettingsNow(s) {
  if (!s.settingsHydrated) return Promise.resolve();
  const seq = ++persistSeq;
  return (async () => {
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 } = s;
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 });
    if (seq !== persistSeq) return;
    await api.storeSet("settings", payload);
  })();
}
function maybePersistMidStream() {
  if (useStore2.getState().anyStreaming()) {
    const now = Date.now();
    if (now - lastMidStreamPersist >= MID_STREAM_MS) {
      lastMidStreamPersist = now;
      writeChatsNow(useStore2.getState());
    }
  } else {
    persistSoon();
  }
}
function flushPendingPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = void 0;
  }
  if (panelPersistTimer) {
    clearTimeout(panelPersistTimer);
    panelPersistTimer = void 0;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("coder:flush-ui"));
  }
  return writeStateNow(useStore2.getState());
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flushPendingPersist().catch((err) => console.error("state flush on unload failed:", err));
  });
  window.addEventListener("pagehide", () => {
    flushPendingPersist().catch((err) => console.error("state flush on pagehide failed:", err));
  });
  api.onFlushPersist(() => {
    Promise.resolve().then(() => flushPendingPersist()).catch((err) => console.error("state flush on quit failed:", err)).finally(() => {
      try {
        api.flushPersistDone();
      } catch (e) {
        console.error("flushPersistDone failed:", e);
      }
    });
  });
}
var persistSeq = 0;
function writeStateNow(s) {
  const { settings, chats, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 } = s;
  const seq = ++persistSeq;
  const writes = [
    (async () => {
      if (seq !== persistSeq) return;
      await api.storeSet("chats", sanitizeChats(chats));
    })()
  ];
  if (s.settingsHydrated) {
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 });
        if (seq !== persistSeq) return;
        await api.storeSet("settings", payload);
      })()
    );
  }
  const del = s.deletedChatIds;
  if (del.length) writes.push(api.storeSet("deleted_chats", del));
  const delW = s.deletedWorkspaceRoots;
  if (delW.length) writes.push(api.storeSet("deleted_workspaces", delW));
  const delP = s.deletedProviderIds;
  if (delP.length) writes.push(api.storeSet("deleted_providers", delP));
  return Promise.all(writes);
}
var MAX_REDO_EXCHANGES = 20;
var historyStacks = /* @__PURE__ */ new Map();
function stackFor(chatId) {
  let st = historyStacks.get(chatId);
  if (!st) {
    st = { undo: [], redo: [] };
    historyStacks.set(chatId, st);
  }
  return st;
}
function abortChatStream(abort) {
  try {
    if (abort && !abort.signal.aborted) abort.abort();
  } catch {
  }
}
var chatDeleteHooks = [];
function runChatDeleteHooks(chatIds) {
  for (const id of chatIds) {
    for (const fn of chatDeleteHooks) {
      try {
        fn(id);
      } catch {
      }
    }
  }
}
var PROVIDER_NAMES = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
);
function defaultProviders() {
  const row = (id, extra = {}) => {
    const meta = PROVIDER_META[id];
    return {
      id: id === "ollama" ? "local" : id,
      name: meta.name,
      kind: id,
      apiKeys: [],
      baseUrl: meta.defaultBaseUrl ?? "",
      model: "",
      ...extra
    };
  };
  return [
    row("openrouter"),
    row("ollama"),
    row("google"),
    row("nvidia"),
    row("cloudflare")
  ];
}
function normalizeThinkingLevelsMap(map) {
  if (!map) return void 0;
  const out = {};
  let kept = 0;
  for (const [model, levels] of Object.entries(map)) {
    if (Array.isArray(levels) && levels.length > 0) {
      out[model] = levels;
      kept++;
    }
  }
  return kept > 0 ? out : void 0;
}
function normalizeProvider(p) {
  const rawKind = p.kind || "";
  const retiredKinds = /* @__PURE__ */ new Set(["opencode", "tokenrouter"]);
  const kind = retiredKinds.has(rawKind) ? "custom" : p.kind || "custom";
  const meta = PROVIDER_META[kind];
  const raw = p;
  const scoped = meta?.accountScopedBaseUrl;
  const storedBase = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  let accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : "";
  if (scoped && !accountId) accountId = accountIdFromBase(storedBase);
  const baseUrl = scoped ? accountScopedBaseUrl(kind, accountId) ?? "" : storedBase.includes("{") ? "" : storedBase || meta?.defaultBaseUrl || "";
  const keys = [];
  if (Array.isArray(raw.apiKeys)) {
    for (const k of raw.apiKeys) if (typeof k === "string" && k.trim() !== "") keys.push(k);
  }
  if (keys.length === 0 && typeof raw.apiKey === "string" && raw.apiKey.trim() !== "") {
    keys.push(raw.apiKey);
  }
  return {
    // The local llama.cpp provider's id was historically 'ollama'; keep it
    // stable by migrating any legacy rows to the canonical 'local' id.
    id: p.id === "ollama" ? "local" : p.id || "custom",
    name: p.name || PROVIDER_NAMES[kind] || "Custom API",
    kind,
    apiKeys: keys,
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl,
    accountId: scoped ? accountId : void 0,
    model: p.model || "",
    contextMap: p.contextMap,
    manualContextMap: p.manualContextMap,
    manualReasoningMap: p.manualReasoningMap,
    pricingMap: p.pricingMap,
    reasoningMap: p.reasoningMap,
    // An EMPTY array is dropped at load: it carries no trustworthy verdict, and
    // a map full of them would hide the picker on every model. Only the levels
    // a source really enumerated (a non-empty list) are kept.
    thinkingLevelsMap: normalizeThinkingLevelsMap(p.thinkingLevelsMap),
    thinkingLevel: p.thinkingLevel ?? "",
    models: Array.isArray(p.models) ? p.models : [],
    removedModels: Array.isArray(p.removedModels) ? p.removedModels : [],
    addedModels: Array.isArray(p.addedModels) ? p.addedModels : []
  };
}
var MAX_PINNED_RECENT_MODELS = 3;
function sortRecentModels(list) {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
  });
}
function normalizeRecentModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      out.push({ providerId: "", model: entry.trim(), lastUsed: Date.now() });
    } else if (entry && typeof entry === "object") {
      const e = entry;
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const pid = typeof e.providerId === "string" ? e.providerId : "";
      const lastUsed = typeof e.lastUsed === "number" ? e.lastUsed : Date.now();
      const pinned2 = e.pinned === true;
      if (model) out.push({ providerId: pid === "ollama" ? "local" : pid, model, lastUsed, ...pinned2 ? { pinned: true } : {} });
    }
  }
  const ordered = sortRecentModels(out);
  const pinned = ordered.filter((r) => r.pinned).slice(0, MAX_PINNED_RECENT_MODELS);
  const pinnedKeys = new Set(pinned.map((r) => `${r.providerId}/${r.model}`));
  for (const r of ordered) {
    if (r.pinned && !pinnedKeys.has(`${r.providerId}/${r.model}`)) delete r.pinned;
  }
  return [...pinned, ...ordered.filter((r) => !r.pinned)].slice(0, 20);
}
function dedupeChats(chats) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let i = chats.length - 1; i >= 0; i--) {
    const c2 = chats[i];
    if (!c2?.id || seen.has(c2.id)) continue;
    seen.add(c2.id);
    out.push(c2);
  }
  out.reverse();
  return out;
}
function selectLoadedChats(prev, incoming, opts) {
  const fresh = incoming && incoming.length > 0 ? incoming : [];
  if (fresh.length === 0 && prev.length > 0) {
    if (opts.settingsMissing && opts.hasSettingsFile) {
      return { chats: prev, kept: true, emptyMiss: true };
    }
    if (!opts.settingsMissing) {
      return { chats: prev, kept: true, emptyMiss: false };
    }
    return { chats: [], kept: false, emptyMiss: false };
  }
  return { chats: fresh, kept: false, emptyMiss: false };
}
var HYDRATED_CHAT_CAP = 10;
var HYDRATED_BYTE_BUDGET = 24 * 1024 * 1024;
function approxBytes(v, depth = 0) {
  if (typeof v === "string") return v.length;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  if (!v || typeof v !== "object" || depth > 3) return 16;
  if (Array.isArray(v)) {
    let n2 = 0;
    for (const item of v) n2 += approxBytes(item, depth + 1);
    return n2;
  }
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    n += k.length + approxBytes(val, depth + 1);
  }
  return n;
}
var bodyBytes = /* @__PURE__ */ new Map();
var hydratePromises = /* @__PURE__ */ new Map();
function applyChatBody(body) {
  const src = body;
  const messages = Array.isArray(src.messages) ? src.messages : [];
  bodyBytes.set(body.id, approxBytes(messages));
  useStore2.setState((s) => {
    let changed = false;
    const chats = s.chats.map((c2) => {
      if (c2.id !== body.id) return c2;
      changed = true;
      return {
        ...body,
        mode: src.mode ? normalizeMode(src.mode) : c2.mode,
        messages,
        messageCount: messages.length,
        hydrated: true,
        pendingAsk: c2.pendingAsk ?? null,
        pendingPermission: c2.pendingPermission ?? null,
        draft: c2.draft,
        scrollPos: c2.scrollPos ?? body.scrollPos ?? null,
        updatedAt: Math.max(c2.updatedAt ?? 0, body.updatedAt ?? 0)
      };
    });
    return changed ? { chats } : {};
  });
}
function chatIsStreaming(c2) {
  return c2.messages.some((m) => m.streaming);
}
function evictChatBodies() {
  const s = useStore2.getState();
  if (persistTimer) return;
  const keep = /* @__PURE__ */ new Set([s.activeChatId]);
  const candidates = s.chats.filter((c2) => c2.hydrated === true && !keep.has(c2.id) && !chatIsStreaming(c2)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (candidates.length <= HYDRATED_CHAT_CAP) {
    const total = candidates.reduce((n, c2) => n + (bodyBytes.get(c2.id) ?? 0), 0);
    if (total <= HYDRATED_BYTE_BUDGET) return;
  }
  const drop = /* @__PURE__ */ new Set();
  let bytes = 0;
  candidates.forEach((c2, i) => {
    bytes += bodyBytes.get(c2.id) ?? 0;
    if (i >= HYDRATED_CHAT_CAP || bytes > HYDRATED_BYTE_BUDGET) drop.add(c2.id);
  });
  for (const id of drop) bodyBytes.delete(id);
  useStore2.setState((st) => ({
    chats: st.chats.map(
      (c2) => drop.has(c2.id) ? {
        ...c2,
        messages: [],
        messageCount: c2.messageCount ?? 0,
        hydrated: false
      } : c2
    )
  }));
}
function isChatBodyReady(id) {
  const c2 = useStore2.getState().chats.find((x) => x.id === id);
  return !!c2 && c2.hydrated !== false;
}
function ensureChatHydrated(id) {
  const chat = useStore2.getState().chats.find((c2) => c2.id === id);
  if (!chat) return Promise.resolve();
  if (chat.hydrated !== false) {
    evictChatBodies();
    return Promise.resolve();
  }
  const inflight = hydratePromises.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const body = await api.chatGet(id);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        applyChatBody(body);
      } else {
        useStore2.setState((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id ? { ...c2, messages: [], hydrated: true, messageCount: 0 } : c2
          )
        }));
      }
    } catch {
    } finally {
      hydratePromises.delete(id);
      evictChatBodies();
    }
  })();
  hydratePromises.set(id, p);
  return p;
}
function makeChat(mode = "ask") {
  const now = Date.now();
  const s = useStore2.getState();
  const activeProvider = s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ?? s.settings.providers[0];
  const recent = sortRecentModels(s.recentModels)[0];
  const recentProvider = recent ? s.settings.providers.find((p) => p.id === recent.providerId) : void 0;
  const providerId = recentProvider?.id ?? activeProvider?.id;
  const model = recentProvider && recent ? recent.model : activeProvider?.model;
  let id = uid();
  while (s.chats.some((c2) => c2.id === id)) id = uid();
  return {
    id,
    title: "New chat",
    mode,
    // A new chat starts at the strongest reasoning level. Users who want a
    // cheaper/faster turn can drop it with the composer pill, and the choice is
    // remembered per chat — so the default only decides where a fresh chat
    // starts, never overrides an explicit pick.
    thinkingLevel: "xhigh",
    providerId,
    model,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}
function workspaceKey(root) {
  return root || "__none__";
}
function workspaceLabel(root) {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!trimmed) return "No project";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
function makeWorkspace(root) {
  const key = workspaceKey(root);
  return { key, root: root || null, label: workspaceLabel(root) };
}
var useStore2 = create((set, get) => ({
  loaded: false,
  settingsHydrated: false,
  settings: { providers: defaultProviders(), activeProviderId: "openrouter", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80, disableTextSuggestions: true, nvimTerminal: DEFAULT_NVIM_TERMINAL, terminalShell: DEFAULT_TERMINAL_SHELL },
  builtinMcp: [],
  root: "",
  theme: DEFAULT_THEME,
  dir: "rtl",
  fontSize: 14,
  viewerFontSize: DEFAULT_VIEWER_FONT_SIZE,
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  webSearchAutoFetch: 5,
  sttProviderId: "",
  sttModel: "whisper-1",
  sttFallbacks: [],
  sttLanguage: "fa",
  sttPrompt: "",
  ttsProviderId: "",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
  ttsFallbacks: [],
  liveProviderId: "",
  liveModel: "",
  liveVoice: "",
  liveVoiceChatId: null,
  liveVoiceState: "idle",
  recentModels: [],
  subagentModels: {},
  subagentThinking: {},
  toolFallbacks: {},
  cacheTtlMinutes: 60,
  historyLimit: 0,
  /** Bytes of skill catalog allowed in the system prompt each turn (see
   *  skillCatalogMaxChars in Settings → Skills). */
  skillCatalogMaxChars: 6e3,
  searchPlugins: [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
  marketplaces: DEFAULT_MARKETPLACES,
  marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION,
  searchConsole: { clientId: "", clientSecret: "", refreshToken: "", siteUrl: "" },
  sidebarOpen: true,
  rightPanelOpen: false,
  terminalPanelOpen: typeof window !== "undefined" ? loadTerminalPanel() : false,
  terminalFullscreen: typeof window !== "undefined" ? loadTerminalFullscreen() : false,
  terminalHeight: typeof window !== "undefined" ? loadTerminalHeight() : DEFAULT_TERMINAL_HEIGHT,
  dataPath: "",
  workspaceColors: {},
  pinnedWorkspaces: [],
  pinnedChats: [],
  workspaces: [],
  chats: [],
  deletedChatIds: [],
  deletedWorkspaceRoots: [],
  deletedProviderIds: [],
  activeChatId: typeof window !== "undefined" ? loadActiveChat() : "",
  openChatIds: typeof window !== "undefined" ? loadOpenChats() : [],
  visibleChatIds: typeof window !== "undefined" ? loadVisibleChats() : [],
  chatWindowSizes: typeof window !== "undefined" ? loadWindowSizes() : {},
  chatLayout: typeof window !== "undefined" ? loadChatLayout() : "vertical",
  chatTree: typeof window !== "undefined" ? loadChatTree() : null,
  recentlyClosedChatTabs: [],
  chatFullscreen: typeof window !== "undefined" ? loadChatFullscreen() : false,
  windowFullscreenId: typeof window !== "undefined" ? loadWindowFullscreen() : null,
  focusComposer: false,
  unreadChats: [],
  prefixNotice: null,
  settingsOpen: false,
  scheduleFormOpen: false,
  schedules: [],
  setScheduleFormOpen: (open) => set({ scheduleFormOpen: open }),
  setSchedules: (schedules) => set({ schedules }),
  scheduleInboxOpen: false,
  setScheduleInboxOpen: (open) => set({ scheduleInboxOpen: open }),
  scheduleInboxSelected: null,
  setScheduleInboxSelected: (id) => set({ scheduleInboxSelected: id }),
  scheduleRunsSeen: [],
  markScheduleRunsSeen: (ids) => {
    set((s) => ({ scheduleRunsSeen: [.../* @__PURE__ */ new Set([...s.scheduleRunsSeen, ...ids])].slice(-MAX_SCHEDULE_RUNS_SEEN) }));
    get().persist();
  },
  isStreaming: false,
  isThinking: false,
  outsideAllowed: false,
  outsideFolders: [],
  computerUse: false,
  browserUse: false,
  chatAborts: {},
  setChatAbort: (chatId, abort) => set((s) => ({ chatAborts: { ...s.chatAborts, [chatId]: abort } })),
  chatBusy: {},
  setChatBusy: (chatId, busy) => set((s) => {
    const isBusy = s.chatBusy[chatId] === true;
    if (busy === isBusy) return {};
    if (busy) {
      return { chatBusy: { ...s.chatBusy, [chatId]: true } };
    }
    const next = { ...s.chatBusy };
    delete next[chatId];
    return { chatBusy: next };
  }),
  load: async () => {
    const [settings, chats, deletedProviders] = await Promise.all([
      api.storeGet("settings"),
      api.storeGet("chats"),
      // Provider deletions are tombstoned so the Rust store's id-union (and the
      // built-in backfill below) cannot resurrect a provider the user removed.
      api.storeGet("deleted_providers")
    ]);
    let hasSettingsFile = false;
    try {
      hasSettingsFile = await api.hasSettingsFile() ?? false;
    } catch {
    }
    let realDataPath = "";
    try {
      realDataPath = await api.getDataPath() ?? "";
    } catch {
    }
    const prevChats = get().chats;
    const picked = selectLoadedChats(prevChats, chats, {
      settingsMissing: settings == null,
      hasSettingsFile
    });
    if (picked.emptyMiss) {
      set({ loaded: true });
      return;
    }
    const keptChats = picked.kept;
    const loadedChats0 = picked.chats;
    const dedupedChats = dedupeChats(loadedChats0);
    const providerIds = (settings?.providers ?? []).map((p) => p.id);
    const loadedChats = dedupedChats.map((c2) => {
      const clean = { ...c2 };
      delete clean.compacting;
      delete clean.compactProgress;
      delete clean.compactNotice;
      delete clean.compactError;
      delete clean.cmdError;
      delete clean.skillNotice;
      delete clean.undoNotice;
      delete clean.stalled;
      const migrated = normalizeUsageEntry(
        clean.usage,
        c2.providerId ?? settings?.activeProviderId ?? "",
        providerIds
      );
      const next = migrated ? { ...clean, usage: migrated } : clean;
      if (Array.isArray(next.messages) && next.messages.length > 0) {
        let touched = false;
        const messages = next.messages.map((m) => {
          const acts = m.toolActivity;
          if (!Array.isArray(acts) || acts.length === 0) return m;
          const ren = acts.some((a) => a && (a.tool === "task" || a.tool === "subagent"));
          if (!ren) return m;
          touched = true;
          return { ...m, toolActivity: normalizeToolActivity(acts) };
        });
        if (touched) next.messages = messages;
      }
      if (next.goal?.active && !next.goal.paused) {
        next.goal = { ...next.goal, stopped: true };
      }
      const withMode = next.mode ? { ...next, mode: normalizeMode(next.mode) } : next;
      const queued = pruneQueued(withMode.queued);
      const base = queued === withMode.queued ? withMode : { ...withMode, queued };
      if (Array.isArray(next.messages)) bodyBytes.set(base.id, approxBytes(next.messages));
      return {
        ...base,
        messages: Array.isArray(base.messages) ? base.messages : [],
        hydrated: Array.isArray(next.messages)
      };
    });
    const prevActiveId = get().activeChatId;
    const memOpen = get().openChatIds;
    const memVisible = get().visibleChatIds ?? [];
    const fallbackActive = keptChats && prevChats.some((c2) => c2.id === prevActiveId) ? prevActiveId : loadedChats[loadedChats.length - 1]?.id ?? "";
    const validIds = new Set(loadedChats.map((c2) => c2.id));
    let openChatIds;
    let activeId;
    let visibleChatIds;
    if (keptChats && memOpen.length > 0) {
      openChatIds = memOpen.filter((id) => validIds.has(id));
      activeId = validIds.has(fallbackActive) ? fallbackActive : openChatIds[openChatIds.length - 1] ?? "";
      if (activeId && !openChatIds.includes(activeId)) openChatIds = [...openChatIds, activeId];
      if (openChatIds.length === 0 && loadedChats.length > 0 && activeId) openChatIds = [activeId];
      visibleChatIds = normalizeVisibleChats(memVisible.length > 0 ? memVisible : [activeId], validIds, activeId);
    } else {
      const storedOpen = loadOpenChats().filter((id) => validIds.has(id));
      const storedActive = loadActiveChat();
      const candidate = validIds.has(storedActive) ? storedActive : fallbackActive;
      openChatIds = storedOpen;
      if (candidate && !openChatIds.includes(candidate)) openChatIds = [...openChatIds, candidate];
      if (openChatIds.length === 0 && candidate) openChatIds = [candidate];
      activeId = validIds.has(candidate) ? candidate : openChatIds[openChatIds.length - 1] ?? "";
      if (openChatIds.length > 0 || activeId) persistOpenState(openChatIds, activeId);
      const storedVisible = loadVisibleChats().filter((id) => validIds.has(id));
      visibleChatIds = normalizeVisibleChats(storedVisible.length > 0 ? storedVisible : activeId ? [activeId] : [], validIds, activeId);
      if (visibleChatIds.length > 0) persistVisibleChats(visibleChatIds);
    }
    const storedTree = typeof window !== "undefined" ? normalizeTree(loadChatTree(), validIds) : null;
    let chatTree = storedTree;
    const treeIds = chatTree ? collectChatIds(chatTree) : [];
    if (treeIds.length === 0) {
      chatTree = visibleChatIds.length > 0 ? buildFromList(visibleChatIds, treeDirFromLayout(loadChatLayout())) : null;
      if (chatTree) persistChatTree(chatTree);
    } else {
      const synced = normalizeVisibleChats(treeIds, validIds, activeId);
      if (JSON.stringify(synced) !== JSON.stringify(visibleChatIds)) {
        visibleChatIds = synced;
        persistVisibleChats(visibleChatIds);
      }
    }
    const raw = await decryptSettings(settings ?? {});
    let providers;
    let activeProviderId = "";
    const deadProviders = new Set(Array.isArray(deletedProviders) ? deletedProviders : []);
    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
      providers = raw.providers.map(normalizeProvider).filter((p) => !deadProviders.has(p.id));
      const present = new Set(providers.map((p) => p.id));
      for (const def of defaultProviders()) {
        if (!present.has(def.id) && !deadProviders.has(def.id)) providers.push(def);
      }
      activeProviderId = providers.some((p) => p.id === raw.activeProviderId) ? raw.activeProviderId : providers[0].id;
    } else if (raw.provider) {
      const oldP = raw.provider;
      const kind = oldP.id === "openrouter" || oldP.id === "ollama" ? oldP.id : "custom";
      const name = PROVIDER_NAMES[kind];
      const legacy = normalizeProvider({
        id: oldP.id || "custom",
        name: name || oldP.name || "Custom API",
        kind,
        apiKeys: typeof oldP.apiKey === "string" && oldP.apiKey ? [oldP.apiKey] : [],
        baseUrl: kind === "custom" || kind === "ollama" ? oldP.baseUrl || "" : "",
        model: oldP.model || ""
      });
      const defs = defaultProviders().filter((p) => p.id !== legacy.id);
      providers = [legacy, ...defs];
      activeProviderId = legacy.id;
    } else {
      providers = defaultProviders();
      activeProviderId = providers[0].id;
    }
    const legacyGoogle = raw.providers?.find(
      (p) => p && p.kind === "google"
    );
    const legacySc = raw.searchConsole;
    const migratedSc = {
      clientId: legacySc?.clientId ?? legacyGoogle?.oauthClientId ?? "",
      clientSecret: legacySc?.clientSecret ?? legacyGoogle?.oauthClientSecret ?? "",
      refreshToken: legacySc?.refreshToken ?? legacyGoogle?.oauthRefreshToken ?? "",
      siteUrl: legacySc?.siteUrl ?? ""
    };
    const loadedSettings = {
      providers,
      activeProviderId,
      systemPrompts: migrateModePrompts(raw.systemPrompts ?? {}),
      modes: Array.isArray(raw.modes) ? raw.modes.filter((m) => m && !BUILTIN_IDS.has(m.id)) : [],
      mcpServers: raw.mcpServers ?? {},
      mcpEnabled: Array.isArray(raw.mcpEnabled) ? raw.mcpEnabled.filter((n) => !!raw.mcpServers?.[n]) : [],
      compactAtPercent: typeof raw.compactAtPercent === "number" && raw.compactAtPercent >= 1 && raw.compactAtPercent <= 99 ? Math.round(raw.compactAtPercent) : 80,
      // Nested settings keys are NOT carried over from disk automatically —
      // only the ones listed in this literal survive a restart.
      disableTextSuggestions: typeof raw.disableTextSuggestions === "boolean" ? raw.disableTextSuggestions : true,
      // Where Neovim / "open terminal" launches. Unknown values fall back to the
      // documented default so an id dropped in a future release cannot strand the
      // user on a terminal that no longer exists.
      nvimTerminal: resolveNvimTerminal(raw.nvimTerminal),
      terminalShell: typeof raw.terminalShell === "string" ? raw.terminalShell.trim() : DEFAULT_TERMINAL_SHELL
    };
    const fontSize = typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 24 ? raw.fontSize : 14;
    document.documentElement.style.setProperty("--chat-font-size", `${fontSize}px`);
    const viewerFontSize = clampCodeFontSize(raw.viewerFontSize, DEFAULT_VIEWER_FONT_SIZE);
    document.documentElement.style.setProperty("--viewer-font-size", `${viewerFontSize}px`);
    const terminalFontSize = clampCodeFontSize(raw.terminalFontSize, DEFAULT_TERMINAL_FONT_SIZE);
    document.documentElement.style.setProperty("--terminal-font-size", `${terminalFontSize}px`);
    applyTerminalFontSize(terminalFontSize);
    let workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map((w) => ({
      key: String(w?.key ?? workspaceKey(String(w?.root ?? ""))),
      root: typeof w?.root === "string" ? w.root : null,
      label: String(w?.label ?? "").trim() || workspaceLabel(String(w?.root ?? ""))
    })) : [];
    const chatRoots = [...new Set(loadedChats.map((c2) => c2.root ?? ""))];
    if (workspaces.length === 0 && chatRoots.length > 0) {
      workspaces = chatRoots.map(makeWorkspace);
    } else {
      const known = new Set(workspaces.map((w) => w.key));
      for (const r of chatRoots) {
        if (!known.has(workspaceKey(r))) workspaces.push(makeWorkspace(r));
      }
    }
    if (settings == null && get().workspaces.length > 0) {
      const cur = get().workspaces;
      const known = new Set(cur.map((w) => w.key));
      workspaces = [...cur];
      for (const r of chatRoots) {
        const k = workspaceKey(r);
        if (!known.has(k)) {
          known.add(k);
          workspaces.push(makeWorkspace(r));
        }
      }
    }
    const root = typeof raw.root === "string" ? raw.root : "";
    const dbMcp = await listMcp();
    const mergedMcp = {
      ...loadedSettings.mcpServers ?? {},
      ...dbMcp.mcpServers ?? {}
    };
    const retired = mergedMcp.playwright;
    if (retired?.command === "npx" && Array.isArray(retired.args) && retired.args.length === 2 && retired.args[0] === "-y" && retired.args[1] === "@playwright/mcp@latest") {
      delete mergedMcp.playwright;
    }
    loadedSettings.mcpServers = mergedMcp;
    const builtins = (dbMcp.builtins ?? []).filter((n) => mergedMcp[n]);
    const userEnabled = raw.mcpEnabled;
    const enabledSet = new Set(
      Array.isArray(userEnabled) ? userEnabled.filter((n) => !!mergedMcp[n]) : []
    );
    loadedSettings.mcpEnabled = [...enabledSet];
    const searchPlugins = Array.isArray(raw.searchPlugins) ? dedupeByKind(
      raw.searchPlugins.filter((p) => ["duckduckgo", "tavily"].includes(p.kind)).map((p) => {
        const kind = p.kind;
        return {
          kind,
          label: SEARCH_PLUGIN_LABELS[kind] || p.label || "",
          enabled: p.enabled !== false,
          order: typeof p.order === "number" ? p.order : 0,
          apiKey: p.apiKey || ""
        };
      })
    ) : [];
    set({
      loaded: true,
      // Only treat persisted settings as authoritative once the sidecar
      // actually returned them. A cold-start where the external volume isn't
      // mounted yet returns null here — the store stays on defaults and refuses
      // to persist them until a refresh returns the real file. A genuine first
      // run (no settings file at all) is fine to persist, though.
      settingsHydrated: settings !== null || !hasSettingsFile,
      settings: loadedSettings,
      builtinMcp: builtins,
      root,
      dir: raw.dir === "ltr" ? "ltr" : "rtl",
      fontSize,
      dataPath: typeof raw.dataPath === "string" && raw.dataPath.trim() ? raw.dataPath : realDataPath || "",
      // No on-device STT anymore: an empty id means "not selected", never a
      // magic 'local' row (the legacy value is migrated away here).
      sttProviderId: typeof raw.sttProviderId === "string" && raw.sttProviderId.trim() && raw.sttProviderId !== "local" ? raw.sttProviderId : "",
      sttModel: typeof raw.sttModel === "string" && raw.sttModel.trim() ? raw.sttModel : "whisper-1",
      sttFallbacks: normalizeSttFallbacks(raw.sttFallbacks),
      // Per-tool fallback lists live in the SETTINGS document (they belong to
      // the UI), so they are read from `raw`, not from a store-level key.
      toolFallbacks: normalizeToolFallbacks(raw.toolFallbacks),
      // Empty means "auto": resolveSttLanguage() then follows the UI direction.
      sttLanguage: typeof raw.sttLanguage === "string" ? raw.sttLanguage.trim().toLowerCase() : "fa",
      sttPrompt: typeof raw.sttPrompt === "string" ? raw.sttPrompt : "",
      ttsProviderId: typeof raw.ttsProviderId === "string" && raw.ttsProviderId.trim() !== "local" ? raw.ttsProviderId.trim() : "",
      // خالی مجاز است (پروایدرهای 9router بدون مدل/ویس): فقط وقتی فیلد اصلاً
      // رشته نیست (settings قدیمی) پیش‌فرض می‌گذاریم، نه وقتی کاربر پاکش کرده.
      ttsModel: typeof raw.ttsModel === "string" ? raw.ttsModel.trim() : "tts-1",
      ttsVoice: typeof raw.ttsVoice === "string" ? raw.ttsVoice.trim() : "alloy",
      ttsFallbacks: normalizeTtsFallbacks(raw.ttsFallbacks),
      // Realtime speech-to-speech. All three empty means "not configured",
      // which makes live voice use the chunked STT + TTS pipeline instead.
      liveProviderId: typeof raw.liveProviderId === "string" ? raw.liveProviderId.trim() : "",
      liveModel: typeof raw.liveModel === "string" ? raw.liveModel.trim() : "",
      liveVoice: typeof raw.liveVoice === "string" ? raw.liveVoice.trim() : "",
      subagentModels: (() => {
        if (typeof raw.subagentModels !== "object" || raw.subagentModels === null) return {};
        return withOtherSlotsFilled(raw.subagentModels);
      })(),
      subagentThinking: (() => {
        if (raw.subagentThinking === void 0 || raw.subagentThinking === null) {
          return { explore: "low" };
        }
        if (typeof raw.subagentThinking !== "object") return {};
        const m = { ...raw.subagentThinking };
        for (const k of Object.keys(m)) m[k] === "max" && (m[k] = "xhigh");
        return m;
      })(),
      // Coerce numbers defensively: settings.json may round-trip numbers
      // through JSON safely, but the IPC layer or an older settings file
      // can hand us string-shaped digits ("30") or null. Accept anything that
      // coerces to a valid value rather than silently falling back to the
      // default — the user did set it, so don't erase their choice.
      cacheTtlMinutes: coercePositiveInt(raw.cacheTtlMinutes, 60),
      historyLimit: coerceNonNegInt(raw.historyLimit, 0),
      // The agent clamps this to [1500, 12000] when it builds the catalog, so a
      // hand-edited file cannot disable the skill list entirely.
      skillCatalogMaxChars: coerceBoundedInt(raw.skillCatalogMaxChars, 6e3, 1500, 12e3),
      // 0 is a valid, deliberate value (page fetch disabled) — keep it.
      webSearchAutoFetch: coerceBoundedInt(raw.webSearchAutoFetch, 5, 0, 10),
      // Hard desktop-control switch: absent/false in old settings files = OFF.
      computerUse: raw.computerUse === true,
      // Hard browsing switch: absent/false in old settings files = OFF, which is
      // also what stops the agent from opening a browser window on its own.
      browserUse: raw.browserUse === true,
      // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
      // are dropped here so they disappear from Settings → Plugins on reload.
      searchPlugins: searchPlugins.length > 0 ? searchPlugins : [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
      // Hand-edited or half-written rows are dropped rather than kept as a
      // broken source the browse UI would keep retrying: a marketplace with no
      // repo cannot be read at all.
      marketplaces: (() => {
        const rows = (Array.isArray(raw.marketplaces) ? raw.marketplaces : []).filter((m) => !!m && typeof m.repo === "string" && !!m.repo.trim()).map((m) => ({
          repo: m.repo.trim(),
          // The kind survives the round-trip: dropping it here silently
          // filed EVERY marketplace under the Plugins tab after a reload.
          ...m.kind ? { kind: m.kind } : {},
          ...m.label ? { label: m.label } : {},
          ...m.path ? { path: m.path } : {},
          ...m.git_ref ? { git_ref: m.git_ref } : {}
        }));
        const fileVersion = Number(
          raw.marketplaceDefaultsVersion ?? 0
        );
        if (!("marketplaces" in raw)) return DEFAULT_MARKETPLACES;
        return mergeShippedMarketplaces(
          rows,
          DEFAULT_MARKETPLACES,
          fileVersion,
          MARKETPLACE_DEFAULTS_VERSION
        );
      })(),
      // The file now CARRIES the current default set (the merge above applied
      // it), so it is stamped as such: re-running the merge on every launch
      // would keep re-adding the kinds it missed and never let the file settle.
      marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION,
      searchConsole: migratedSc,
      recentModels: Array.isArray(raw.recentModels) ? normalizeRecentModels(raw.recentModels) : [],
      sidebarOpen: raw.sidebarOpen !== false,
      rightPanelOpen: raw.rightPanelOpen === true,
      workspaceColors: raw.workspaceColors ?? {},
      pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
      pinnedChats: Array.isArray(raw.pinnedChats) ? raw.pinnedChats : [],
      scheduleRunsSeen: normalizeScheduleRunsSeen(raw.scheduleRunsSeen),
      workspaces,
      chats: loadedChats,
      activeChatId: activeId,
      openChatIds,
      visibleChatIds,
      chatTree,
      // Self-clean pre-existing empty chats left on disk by older builds (a
      // fresh tab used to persist immediately). They stay usable in-memory
      // but are queued for file deletion on the next persist; live chats that
      // already have messages are untouched. In-memory-only empty tabs can
      // never appear here (they are filtered from disk writes), so this only
      // ever matches stale files.
      deletedChatIds: [
        .../* @__PURE__ */ new Set([
          ...get().deletedChatIds,
          // Self-clean stale empty chats left on disk by older builds (a fresh
          // tab used to persist immediately). Only chats whose BODY is really
          // in memory and empty qualify — an index-only row must never be
          // queued for deletion, or the migration's own rows would wipe the
          // sidebar on the first load.
          ...loadedChats.filter((c2) => c2.hydrated === true && (c2.messages?.length ?? 0) === 0).map((c2) => c2.id)
        ])
      ]
    });
    {
      const wanted = new Set(
        [activeId, ...openChatIds, ...visibleChatIds].filter(Boolean)
      );
      for (const id of wanted) void ensureChatHydrated(id);
    }
  },
  persist: () => {
    if (get().anyStreaming()) {
      const now = Date.now();
      if (now - lastMidStreamPersist >= MID_STREAM_MS) {
        lastMidStreamPersist = now;
        writeChatsNow(get());
      } else {
        persistSoon();
      }
      return;
    }
    lastMidStreamPersist = 0;
    writeStateNow(get());
  },
  flushNow: () => {
    flushPendingPersist();
  },
  setProviderConfig: (patch) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map(
          (p) => p.id === s.settings.activeProviderId ? { ...p, ...patch } : p
        ),
        activeProviderId: s.settings.activeProviderId
      }
    }));
    get().persist();
  },
  updateProvider: (id, patch) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map(
          (p) => p.id === id ? normalizeProvider({ ...p, ...patch }) : p
        ),
        activeProviderId: s.settings.activeProviderId
      }
    }));
    get().persist();
  },
  addProvider: () => {
    const id = `custom-${Date.now().toString(36)}`;
    const provider = {
      id,
      name: "New provider",
      kind: "custom",
      apiKeys: [],
      baseUrl: "",
      model: "",
      models: []
    };
    set((s) => ({
      settings: { ...s.settings, providers: [...s.settings.providers, provider] }
    }));
    get().persist();
    return id;
  },
  removeProvider: (id) => {
    set((s) => {
      const providers = s.settings.providers.filter((p) => p.id !== id);
      const out = providers.length > 0 ? providers : defaultProviders();
      const active = s.settings.activeProviderId === id || !out.some((p) => p.id === s.settings.activeProviderId) ? out[0].id : s.settings.activeProviderId;
      return {
        settings: { ...s.settings, providers: out, activeProviderId: active },
        // Tombstone the id: the store unions providers by id, so without this
        // the removed row would be restored by the next settings write.
        deletedProviderIds: s.deletedProviderIds.includes(id) ? s.deletedProviderIds : [...s.deletedProviderIds, id]
      };
    });
    get().persist();
  },
  setActiveProvider: (id) => {
    set((s) => {
      if (!s.settings.providers.some((p) => p.id === id)) return {};
      return { settings: { ...s.settings, activeProviderId: id } };
    });
    get().persist();
  },
  setProviderModels: (id, models) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map(
          (p) => p.id === id ? {
            ...p,
            models: Array.from(new Set(models.filter(Boolean))),
            // Explicitly re-added models are no longer hidden.
            removedModels: (p.removedModels ?? []).filter((m) => !models.includes(m)),
            // Manual models survive as long as they are still in the list.
            addedModels: (p.addedModels ?? []).filter((m) => models.includes(m))
          } : p
        )
      }
    }));
    get().persist();
  },
  // افزودن دستی یک مدل به پروایدر: هم به لیست ظاهری اضافه می‌شود و هم در
  // addedModels ثبت می‌شود تا فچ‌های بعدی (حتی ناموفق) آن را حذف نکنند.
  // افزودن دستی مدل + ثبت اختیاری کانتکست دستی؛ ورودی دستی کانتکست فقط برای
  // kind‌هایی معنا دارد که /models‌شان پنجره‌ی قابل‌اعتماد گزارش نمی‌کند
  // (`manualContextInput` در PROVIDER_META — همین یک رجیستری، بدون چک done‌شده‌ی kind).
  addManualModel: (id, model, contextTokens) => {
    const m = model.trim();
    if (!m) return;
    const ctx = typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(contextTokens) : void 0;
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p;
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
          const acceptsManual = !!PROVIDER_META[p.kind]?.manualContextInput;
          const manual = ctx !== void 0 && acceptsManual ? { ...p.manualContextMap ?? {}, [bare]: ctx } : p.manualContextMap;
          return {
            ...p,
            models: Array.from(/* @__PURE__ */ new Set([...p.models ?? [], m])),
            addedModels: Array.from(/* @__PURE__ */ new Set([...p.addedModels ?? [], m])),
            removedModels: (p.removedModels ?? []).filter((x) => x !== m),
            ...manual !== void 0 ? { manualContextMap: manual } : {}
          };
        })
      }
    }));
    get().persist();
  },
  // ویرایش/حذف مقدار دستی کانتکست یک مدل دستی (کلید نرمال‌شده‌ی bare). مثل
  // افزودن، فقط برای kind‌های دارای manualContextInput اعمال می‌شود.
  setManualModelContext: (id, model, contextTokens) => {
    const m = model.trim();
    if (!m) return;
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p;
          if (!PROVIDER_META[p.kind]?.manualContextInput) return p;
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
          const next = { ...p.manualContextMap ?? {} };
          if (contextTokens === null || !(contextTokens > 0)) delete next[bare];
          else next[bare] = Math.floor(contextTokens);
          return { ...p, manualContextMap: next };
        })
      }
    }));
    get().persist();
  },
  // ثبت/حذف پرچم دستی reasoning برای یک مدل دستی (کلید نرمال‌شده‌ی bare).
  // برخلاف کانتکست، به kind گیت‌وی وابسته نیست: هر مدلی که کاربر دستی اضافه
  // کرده می‌تواند reasoning-capable اعلام شود تا pill تغییر effort در کامپوزر
  // نمایش داده شود و reasoning_effort به بک‌اند ارسال گردد.
  setManualModelReasoning: (id, model, reasoning) => {
    const m = model.trim();
    if (!m) return;
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p;
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
          const next = { ...p.manualReasoningMap ?? {} };
          if (reasoning === null) {
            delete next[bare];
            delete next[m];
          } else {
            next[bare] = reasoning;
          }
          return { ...p, manualReasoningMap: next };
        })
      }
    }));
    get().persist();
  },
  // حذف یک مدل دستی به‌همراه مقادیر دستی کانتکست و reasoning آن.
  removeManualModel: (id, model) => {
    const m = model.trim();
    if (!m) return;
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => {
          if (p.id !== id) return p;
          const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
          const next = { ...p.manualContextMap ?? {} };
          delete next[bare];
          delete next[m];
          const nextReasoning = { ...p.manualReasoningMap ?? {} };
          delete nextReasoning[bare];
          delete nextReasoning[m];
          return {
            ...p,
            models: (p.models ?? []).filter((x) => x !== m),
            addedModels: (p.addedModels ?? []).filter((x) => x !== m),
            manualContextMap: next,
            manualReasoningMap: nextReasoning
          };
        })
      }
    }));
    get().persist();
  },
  setProviderContextMap: (id, contextMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => p.id === id ? { ...p, contextMap } : p)
      }
    }));
    get().persist();
  },
  setProviderPricingMap: (id, pricingMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => p.id === id ? { ...p, pricingMap } : p)
      }
    }));
    get().persist();
  },
  setProviderReasoningMap: (id, reasoningMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => p.id === id ? { ...p, reasoningMap } : p)
      }
    }));
    get().persist();
  },
  /** Record that a provider+model DEMONSTRABLY reasoned (its response streamed
   *  reasoning content). Positive evidence only: a call that produced no
   *  reasoning proves nothing, so `false` is never written and a model that
   *  reasoned once stays marked. Stored under the RAW wire id — a gateway's id
   *  can itself be vendor-namespaced ("nvidia/nemotron-…"), so it must not be
   *  normalized against the provider id. A no-op once recorded, because this
   *  runs on every usage event of every step. */
  learnModelReasoning: (id, model) => {
    const m = model.trim();
    if (!m) return;
    const p = get().settings.providers.find((x) => x.id === id);
    if (!p || (p.observedReasoningMap ?? {})[m] === true) return;
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map(
          (row) => row.id === id ? {
            ...row,
            observedReasoningMap: { ...row.observedReasoningMap ?? {}, [m]: true }
          } : row
        )
      }
    }));
    get().persist();
  },
  setProviderThinkingLevelsMap: (id, thinkingLevelsMap) => {
    set((s) => ({
      settings: {
        ...s.settings,
        providers: s.settings.providers.map((p) => p.id === id ? { ...p, thinkingLevelsMap } : p)
      }
    }));
    get().persist();
  },
  // ترمیم خودکار ارجاع‌های مدلِ ازکاتالوگ‌رفته: وقتی لیست زنده‌ی /models
  // می‌آید، مدل‌های حذف‌شده/تغییرنام‌یافته‌ی پروایدر دیگر معتبر نیستند.
  // چت‌هایی که هنوز روی چنین مدلی هستند به اولین مدل معتبر برمی‌گردند و
  // recents همان پروایدر پاکسازی می‌شوند تا ارسال بعدی هرگز با خطای
  // «No such model» شکست نخورد. updatedAt عمداً دست نمی‌خورد تا ترتیب
  // چت‌ها در سایدبار جابه‌جا نشود.
  healStaleModels: (providerId, validModels) => {
    if (validModels.length === 0) return;
    const bare = (m) => m.startsWith(`${providerId}/`) ? m.slice(providerId.length + 1) : m;
    const valid = new Set(validModels.map(bare));
    const fallback = bare(validModels[0]);
    set((s) => ({
      chats: s.chats.map((c2) => {
        const owner = c2.providerId ?? s.settings.activeProviderId;
        if (owner !== providerId || !c2.model || valid.has(bare(c2.model))) return c2;
        return { ...c2, model: fallback };
      }),
      recentModels: s.recentModels.filter(
        (r) => r.providerId !== providerId || valid.has(bare(r.model))
      )
    }));
    get().persist();
  },
  setMcpServers: (mcpServers) => {
    set((s) => ({ settings: { ...s.settings, mcpServers } }));
    get().persist();
  },
  addMcpServer: (name, cfg) => {
    set((s) => {
      const mcpServers = { ...s.settings.mcpServers ?? {}, [name]: cfg };
      return { settings: { ...s.settings, mcpServers } };
    });
    get().persist();
    void saveMcp(name, cfg);
  },
  updateMcpServer: (name, cfg) => {
    set((s) => {
      const mcpServers = { ...s.settings.mcpServers ?? {}, [name]: cfg };
      return { settings: { ...s.settings, mcpServers } };
    });
    get().persist();
    void saveMcp(name, cfg);
  },
  removeMcpServer: (name) => {
    if (get().builtinMcp.includes(name)) return;
    set((s) => {
      const mcpServers = { ...s.settings.mcpServers ?? {} };
      delete mcpServers[name];
      const mcpEnabled = (s.settings.mcpEnabled ?? []).filter((n) => n !== name);
      return { settings: { ...s.settings, mcpServers, mcpEnabled } };
    });
    get().persist();
    void deleteMcp(name);
  },
  setMcpEnabled: (name, on) => {
    set((s) => {
      const cur = new Set(s.settings.mcpEnabled ?? []);
      if (on) cur.add(name);
      else cur.delete(name);
      return { settings: { ...s.settings, mcpEnabled: [...cur] } };
    });
    get().persist();
  },
  setSystemPrompt: (mode, text) => {
    set((s) => ({
      settings: {
        ...s.settings,
        systemPrompts: { ...s.settings.systemPrompts ?? {}, [mode]: text }
      }
    }));
    get().persist();
  },
  removeMode: (id) => {
    set((s) => {
      const modes = (s.settings.modes ?? []).filter((m) => m.id !== id);
      const systemPrompts = { ...s.settings.systemPrompts ?? {} };
      delete systemPrompts[id];
      return { settings: { ...s.settings, modes, systemPrompts } };
    });
    get().persist();
  },
  setRoot: (root) => {
    set({ root, outsideAllowed: false, outsideFolders: [] });
    get().persist();
  },
  setTheme: (theme) => {
    set({ theme });
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("coder:theme", theme);
    } catch {
    }
  },
  setDir: (dir) => {
    set({ dir });
    get().persist();
  },
  toggleDir: () => {
    const next = get().dir === "rtl" ? "ltr" : "rtl";
    get().setDir(next);
  },
  setFontSize: (fontSize) => {
    const n = Math.min(24, Math.max(10, Math.round(fontSize)));
    document.documentElement.style.setProperty("--chat-font-size", `${n}px`);
    set({ fontSize: n });
    get().persist();
  },
  setViewerFontSize: (viewerFontSize) => {
    const n = Math.min(24, Math.max(9, Math.round(viewerFontSize)));
    document.documentElement.style.setProperty("--viewer-font-size", `${n}px`);
    set({ viewerFontSize: n });
    get().persist();
  },
  setTerminalFontSize: (terminalFontSize) => {
    const n = Math.min(24, Math.max(9, Math.round(terminalFontSize)));
    document.documentElement.style.setProperty("--terminal-font-size", `${n}px`);
    applyTerminalFontSize(n);
    set({ terminalFontSize: n });
    get().persist();
  },
  setDataPath: (dataPath) => {
    set({ dataPath: (dataPath ?? "").trim() });
    get().persist();
  },
  setSttProviderId: (id) => {
    set({ sttProviderId: (id ?? "").trim() });
    get().persist();
  },
  setSttModel: (m) => {
    set({ sttModel: (m ?? "").trim() || "whisper-1" });
    get().persist();
  },
  setSttFallbacks: (f) => {
    set({ sttFallbacks: normalizeSttFallbacks(f) });
    get().persist();
  },
  setToolFallbacks: (slot, rows) => {
    set((s) => {
      const toolFallbacks = { ...s.toolFallbacks };
      const clean = normalizeToolFallbackRows(rows);
      if (clean.length) toolFallbacks[slot] = clean;
      else delete toolFallbacks[slot];
      return { toolFallbacks };
    });
    get().persist();
  },
  setSttLanguage: (l) => {
    set({ sttLanguage: (l ?? "").trim().toLowerCase() });
    get().persist();
  },
  setSttPrompt: (p) => {
    set({ sttPrompt: p ?? "" });
    get().persist();
  },
  setLiveProviderId: (id) => {
    set({ liveProviderId: (id ?? "").trim() });
    get().persist();
  },
  setLiveModel: (m) => {
    set({ liveModel: (m ?? "").trim() });
    get().persist();
  },
  setLiveVoice: (v) => {
    set({ liveVoice: (v ?? "").trim() });
    get().persist();
  },
  setLiveVoiceSession: (liveVoiceChatId, state) => {
    set({ liveVoiceChatId, liveVoiceState: state });
  },
  setTtsProviderId: (id) => {
    set({ ttsProviderId: (id ?? "").trim() });
    get().persist();
  },
  setTtsModel: (m) => {
    set({ ttsModel: (m ?? "").trim() });
    get().persist();
  },
  setTtsVoice: (v) => {
    set({ ttsVoice: (v ?? "").trim() });
    get().persist();
  },
  setTtsFallbacks: (f) => {
    set({ ttsFallbacks: normalizeTtsFallbacks(f) });
    get().persist();
  },
  setWebSearchAutoFetch: (n) => {
    const r = Math.round(n);
    set({ webSearchAutoFetch: Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 5 });
    get().persist();
  },
  setSubagentModel: (agent, model) => {
    set((s) => {
      const subagentModels = { ...s.subagentModels };
      if (model) subagentModels[agent] = model;
      else delete subagentModels[agent];
      return { subagentModels };
    });
    get().persist();
    void pushSlotModel(agent, model);
  },
  setSubagentThinking: (agent, level) => {
    set((s) => {
      const subagentThinking = { ...s.subagentThinking };
      if (level) subagentThinking[agent] = level;
      else delete subagentThinking[agent];
      return { subagentThinking };
    });
    get().persist();
  },
  setMemoryTtlConfig: (c2) => {
    set({
      cacheTtlMinutes: typeof c2.cache === "number" && c2.cache > 0 ? Math.round(c2.cache) : get().cacheTtlMinutes
    });
    get().persist();
  },
  setHistoryLimit: (n) => {
    set({ historyLimit: Math.max(0, Math.round(n) || 0) });
    get().persist();
  },
  setSkillCatalogMaxChars: (n) => {
    set({ skillCatalogMaxChars: Math.min(12e3, Math.max(1500, Math.round(n) || 6e3)) });
    get().persist();
  },
  setSearchPlugins: (plugins) => {
    set({ searchPlugins: plugins });
    get().persist();
  },
  setMarketplaces: (marketplaces) => {
    set({ marketplaces });
    get().persist();
  },
  setSearchConsole: (patch) => {
    set((s) => ({ searchConsole: { ...s.searchConsole, ...patch } }));
    get().persist();
  },
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
    persistPanelsSoon();
  },
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    get().setSidebarOpen(next);
  },
  setRightPanelOpen: (rightPanelOpen) => {
    set({ rightPanelOpen });
    persistPanelsSoon();
  },
  toggleRightPanel: () => {
    const next = !get().rightPanelOpen;
    get().setRightPanelOpen(next);
  },
  setTerminalPanelOpen: (terminalPanelOpen) => {
    set((s) => ({
      terminalPanelOpen,
      terminalFullscreen: terminalPanelOpen ? s.terminalFullscreen : false
    }));
    persistTerminalPanel(terminalPanelOpen);
    if (!terminalPanelOpen) persistTerminalFullscreen(false);
  },
  toggleTerminalPanel: () => {
    const next = !get().terminalPanelOpen;
    get().setTerminalPanelOpen(next);
  },
  setTerminalFullscreen: (v) => {
    if (v && !get().terminalPanelOpen) get().setTerminalPanelOpen(true);
    persistTerminalFullscreen(v);
    set({ terminalFullscreen: v });
  },
  toggleTerminalFullscreen: () => {
    get().setTerminalFullscreen(!get().terminalFullscreen);
  },
  setTerminalHeight: (px) => {
    const next = clampTerminalHeight(px);
    persistTerminalHeight(next);
    set({ terminalHeight: next });
  },
  setRecentModels: (recentModels) => {
    set({ recentModels });
    get().persist();
  },
  addRecentModel: (model, providerId) => {
    const m = (model || "").trim();
    if (!m) return;
    const pid = providerId || "";
    const now = Date.now();
    set((s) => {
      const prev = s.recentModels.find((x) => x.model === m && x.providerId === pid);
      const pinned = prev?.pinned === true;
      const rest = s.recentModels.filter((x) => x.model !== m || x.providerId !== pid);
      const entry = { providerId: pid, model: m, lastUsed: now, ...pinned ? { pinned: true } : {} };
      const pinnedRest = sortRecentModels(rest.filter((x) => x.pinned)).slice(0, MAX_PINNED_RECENT_MODELS);
      const unpinnedRest = sortRecentModels(rest.filter((x) => !x.pinned));
      const recentModels = pinned ? [entry, ...pinnedRest, ...unpinnedRest].slice(0, 20) : [...pinnedRest, entry, ...unpinnedRest].slice(0, 20);
      return { recentModels };
    });
    get().persist();
  },
  removeRecentModel: (model, providerId) => {
    const m = (model || "").trim();
    if (!m) return;
    const pid = providerId || "";
    set((s) => ({
      recentModels: s.recentModels.filter((x) => x.model !== m || x.providerId !== pid || x.pinned)
    }));
    get().persist();
  },
  togglePinRecentModel: (model, providerId) => {
    const m = (model || "").trim();
    if (!m) return false;
    const pid = providerId || "";
    let pinnedNow = false;
    let changed = false;
    set((s) => {
      const target = s.recentModels.find((x) => x.model === m && x.providerId === pid);
      if (!target) return {};
      if (target.pinned) {
        changed = true;
        return { recentModels: sortRecentModels(s.recentModels.map((x) => x.model === m && x.providerId === pid ? { ...x, pinned: void 0 } : x)) };
      }
      if (s.recentModels.filter((x) => x.pinned).length >= MAX_PINNED_RECENT_MODELS) return {};
      pinnedNow = true;
      changed = true;
      return { recentModels: sortRecentModels(s.recentModels.map((x) => x.model === m && x.providerId === pid ? { ...x, pinned: true } : x)) };
    });
    if (changed) get().persist();
    return pinnedNow;
  },
  newChat: (mode) => {
    const chat = makeChat(mode ?? "ask");
    const s = useStore2.getState();
    const prevRoot = s.chats.find((c2) => c2.id === s.activeChatId)?.root;
    const lastRoot = [...s.chats].reverse().find((c2) => c2.root)?.root;
    chat.root = prevRoot ?? lastRoot ?? s.root;
    const activeChatId = chat.id;
    set((st) => {
      const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId];
      persistOpenState(openChatIds, activeChatId);
      const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1;
      if (single) {
        persistVisibleChats([activeChatId]);
        persistChatTree(null);
        return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false };
      }
      const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout);
      const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout));
      const mirrors = persistTreeMirrors(chatTree, st.chatLayout);
      return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false };
    });
    get().persist();
    return activeChatId;
  },
  newChatInRoot: (root, mode) => {
    const key = workspaceKey(root ?? "");
    const chat = makeChat(mode ?? "ask");
    chat.root = root || void 0;
    const activeChatId = chat.id;
    set((st) => {
      let workspaces = st.workspaces;
      if (!workspaces.some((w) => w.key === key)) {
        workspaces = [...workspaces, makeWorkspace(root ?? "")];
      }
      const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId];
      persistOpenState(openChatIds, activeChatId);
      const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1;
      if (single) {
        persistVisibleChats([activeChatId]);
        persistChatTree(null);
        return { workspaces, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false };
      }
      const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout);
      const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout));
      const mirrors = persistTreeMirrors(chatTree, st.chatLayout);
      return { workspaces, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false };
    });
    get().persist();
    return activeChatId;
  },
  createWorkspace: (root) => {
    const key = workspaceKey(root ?? "");
    const ws = makeWorkspace(root ?? "");
    set((s) => {
      const workspaces = s.workspaces.some((w) => w.key === key) ? s.workspaces : [...s.workspaces, ws];
      return { workspaces };
    });
    get().persist();
    return key;
  },
  setWorkspaceOrder: (keys) => {
    set((s) => {
      const ordered = [...keys].map((k) => s.workspaces.find((w) => w.key === k)).filter((w) => Boolean(w));
      const known = new Set(ordered.map((w) => w.key));
      for (const w of s.workspaces) if (!known.has(w.key)) ordered.push(w);
      return { workspaces: ordered };
    });
    get().persist();
  },
  deleteChat: (id) => {
    abortChatStream(get().chatAborts[id]);
    historyStacks.delete(id);
    set((s) => {
      const chats = s.chats.filter((c2) => c2.id !== id);
      const openChatIds = s.openChatIds.filter((cid) => cid !== id);
      let activeChatId = s.activeChatId;
      if (s.activeChatId === id) {
        const idx = s.openChatIds.indexOf(id);
        const remaining = openChatIds;
        activeChatId = remaining[Math.min(Math.max(idx - 1, 0), remaining.length - 1)] ?? chats[chats.length - 1]?.id ?? "";
        if (!remaining.includes(activeChatId) && activeChatId) remaining.push(activeChatId);
      }
      const finalOpen = openChatIds.includes(activeChatId) || !activeChatId ? openChatIds : [...openChatIds, activeChatId];
      persistOpenState(finalOpen, activeChatId);
      const validIds = new Set(chats.map((c2) => c2.id));
      const baseTree = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
      const normalized = normalizeTree(removeChat(baseTree, id), validIds);
      const fallbackVisible = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
      const chatTree = normalized ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null);
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
      const chatWindowSizes = mirrors.chatWindowSizes;
      const chatAborts = { ...s.chatAborts };
      delete chatAborts[id];
      const chatBusy = { ...s.chatBusy };
      delete chatBusy[id];
      return {
        chats,
        activeChatId,
        openChatIds: finalOpen,
        visibleChatIds,
        chatWindowSizes,
        chatTree,
        chatAborts,
        chatBusy,
        deletedChatIds: [...s.deletedChatIds, id],
        pinnedChats: s.pinnedChats.filter((k) => k !== id),
        unreadChats: s.unreadChats.filter((cid) => cid !== id)
      };
    });
    get().persist();
    runChatDeleteHooks([id]);
  },
  deleteWorkspace: (key) => {
    const doomed = get().chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id);
    for (const id of doomed) {
      abortChatStream(get().chatAborts[id]);
      historyStacks.delete(id);
    }
    set((s) => {
      const chats = s.chats.filter((c2) => workspaceKey(c2.root ?? "") !== key);
      const workspaces = s.workspaces.filter((w) => w.key !== key);
      const doomedIds = new Set(
        s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id)
      );
      const pinnedWorkspaces = s.pinnedWorkspaces.filter((k) => k !== key);
      const pinnedChats = s.pinnedChats.filter((k) => !doomedIds.has(k));
      const activeChatId = s.chats.some((c2) => c2.id === s.activeChatId && workspaceKey(c2.root ?? "") !== key) ? s.activeChatId : chats[chats.length - 1]?.id ?? "";
      const openChatIds = s.openChatIds.filter((cid) => !doomedIds.has(cid));
      if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId);
      persistOpenState(openChatIds, activeChatId);
      const validIds = new Set(chats.map((c2) => c2.id));
      const baseTreeWs = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
      let pruned = baseTreeWs;
      for (const dead of doomedIds) pruned = removeChat(pruned, dead);
      const normalizedWs = normalizeTree(pruned, validIds);
      const fallbackWs = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !doomedIds.has(cid)), validIds, activeChatId);
      const chatTreeWs = normalizedWs ?? (fallbackWs.length > 0 ? buildFromList(fallbackWs, treeDirFromLayout(s.chatLayout)) : null);
      const mirrorsWs = persistTreeMirrors(chatTreeWs, s.chatLayout);
      const visibleChatIds = mirrorsWs.visibleChatIds.length > 0 ? mirrorsWs.visibleChatIds : fallbackWs;
      const chatAborts = { ...s.chatAborts };
      for (const id of doomed) delete chatAborts[id];
      return {
        chats,
        workspaces,
        pinnedWorkspaces,
        pinnedChats,
        activeChatId,
        openChatIds,
        visibleChatIds,
        chatTree: chatTreeWs,
        chatWindowSizes: mirrorsWs.chatWindowSizes,
        chatLayout: mirrorsWs.chatLayout,
        chatAborts,
        unreadChats: s.unreadChats.filter((cid) => !doomedIds.has(cid)),
        deletedChatIds: [
          ...s.deletedChatIds,
          ...s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id)
        ],
        deletedWorkspaceRoots: [
          ...s.deletedWorkspaceRoots,
          ...s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.root ?? "")
        ]
      };
    });
    get().persist();
    runChatDeleteHooks(doomed);
  },
  setWorkspaceColor: (key, color) => {
    set((s) => {
      const workspaceColors = { ...s.workspaceColors };
      if (color) workspaceColors[key] = color;
      else delete workspaceColors[key];
      return { workspaceColors };
    });
    get().persist();
  },
  togglePinWorkspace: (key) => {
    set((s) => {
      const wasPinned = s.pinnedWorkspaces.includes(key);
      const pinnedWorkspaces = wasPinned ? s.pinnedWorkspaces.filter((k) => k !== key) : [key, ...s.pinnedWorkspaces];
      return { pinnedWorkspaces };
    });
    get().persist();
  },
  renameWorkspace: (key, label) => {
    set((s) => ({
      workspaces: s.workspaces.map(
        (w) => w.key === key ? { ...w, label } : w
      )
    }));
    get().persist();
  },
  moveWorkspace: (key, root) => {
    const trimmed = (root ?? "").trim();
    const nextRoot = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
    const nextKey = workspaceKey(nextRoot);
    const prev = get().workspaces.find((w) => w.key === key);
    const prevRoot = prev?.root ?? get().chats.find((c2) => workspaceKey(c2.root ?? "") === key)?.root ?? "";
    if (nextKey === key) {
      set((s) => ({
        workspaces: s.workspaces.map(
          (w) => w.key === key ? { ...w, root: nextRoot || null } : w
        ),
        chats: s.chats.map(
          (c2) => workspaceKey(c2.root ?? "") === key ? { ...c2, root: nextRoot || void 0, updatedAt: Date.now() } : c2
        ),
        root: s.root === prevRoot ? nextRoot : s.root
      }));
      get().persist();
      return key;
    }
    if (!prev && get().chats.every((c2) => workspaceKey(c2.root ?? "") !== key)) {
      get().createWorkspace(nextRoot);
      return nextKey;
    }
    set((s) => {
      const targetExists = s.workspaces.some((w) => w.key === nextKey);
      const prevLabel = prev?.label ?? workspaceLabel(prevRoot);
      const label = prev && prevLabel !== workspaceLabel(prevRoot) ? prevLabel : workspaceLabel(nextRoot);
      let workspaces;
      if (targetExists) {
        workspaces = s.workspaces.filter((w) => w.key !== key).map((w) => w.key === nextKey ? { ...w, root: nextRoot || null } : w);
      } else {
        workspaces = s.workspaces.map(
          (w) => w.key === key ? { ...w, key: nextKey, root: nextRoot || null, label } : w
        );
      }
      const workspaceColors = { ...s.workspaceColors };
      if (workspaceColors[key] !== void 0 && workspaceColors[nextKey] === void 0) {
        workspaceColors[nextKey] = workspaceColors[key];
      }
      delete workspaceColors[key];
      return {
        workspaces,
        chats: s.chats.map(
          (c2) => workspaceKey(c2.root ?? "") === key ? { ...c2, root: nextRoot || void 0, updatedAt: Date.now() } : c2
        ),
        workspaceColors,
        pinnedWorkspaces: s.pinnedWorkspaces.map((k) => k === key ? nextKey : k),
        root: s.root === prevRoot ? nextRoot : s.root,
        deletedWorkspaceRoots: prevRoot ? [...s.deletedWorkspaceRoots, prevRoot] : s.deletedWorkspaceRoots
      };
    });
    get().persist();
    return nextKey;
  },
  togglePinChat: (id) => {
    set((s) => {
      const wasPinned = s.pinnedChats.includes(id);
      const pinnedChats = wasPinned ? s.pinnedChats.filter((k) => k !== id) : [id, ...s.pinnedChats];
      return { pinnedChats };
    });
    get().persist();
  },
  setActiveChat: (id) => {
    set((s) => {
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
      persistOpenState(openChatIds, id);
      const single = leafCount(s.chatTree) <= 1 && s.visibleChatIds.length <= 1;
      let chatTree = s.chatTree;
      let visibleChatIds = s.visibleChatIds;
      let chatWindowSizes = s.chatWindowSizes;
      let chatLayout = s.chatLayout;
      if (single) {
        visibleChatIds = [id];
        chatTree = null;
        persistVisibleChats(visibleChatIds);
        persistChatTree(null);
      } else if (!containsChat(chatTree, id)) {
        const base = ensureTree(chatTree, visibleChatIds, s.chatLayout);
        chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
        visibleChatIds = mirrors.visibleChatIds;
        chatWindowSizes = mirrors.chatWindowSizes;
        chatLayout = mirrors.chatLayout;
      }
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds,
        chatTree,
        chatWindowSizes,
        chatLayout,
        // Opening a chat clears its green "new message" dot.
        unreadChats: s.unreadChats.filter((cid) => cid !== id)
      };
    });
    persistSoon();
  },
  openChat: (id) => {
    set((s) => {
      if (!s.chats.some((c2) => c2.id === id)) return {};
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
      persistOpenState(openChatIds, id);
      const single = leafCount(s.chatTree) <= 1 && s.visibleChatIds.length <= 1;
      let chatTree = s.chatTree;
      let visibleChatIds = s.visibleChatIds;
      let chatWindowSizes = s.chatWindowSizes;
      let chatLayout = s.chatLayout;
      if (single) {
        visibleChatIds = [id];
        chatTree = null;
        persistVisibleChats(visibleChatIds);
        persistChatTree(null);
      } else if (!containsChat(chatTree, id)) {
        const base = ensureTree(chatTree, visibleChatIds, s.chatLayout);
        chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
        visibleChatIds = mirrors.visibleChatIds;
        chatWindowSizes = mirrors.chatWindowSizes;
        chatLayout = mirrors.chatLayout;
      }
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds,
        chatTree,
        chatWindowSizes,
        chatLayout,
        unreadChats: s.unreadChats.filter((cid) => cid !== id)
      };
    });
    persistSoon();
  },
  closeChatTab: (id) => {
    set((s) => {
      if (!s.openChatIds.includes(id)) return {};
      const idx = s.openChatIds.indexOf(id);
      const openChatIds = s.openChatIds.filter((cid) => cid !== id);
      let activeChatId = s.activeChatId;
      if (s.activeChatId === id) {
        activeChatId = openChatIds[Math.min(idx, openChatIds.length - 1)] ?? "";
      }
      persistOpenState(openChatIds, activeChatId);
      const validIds = new Set(s.chats.map((c2) => c2.id));
      const baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
      const normalizedCt = normalizeTree(removeChat(baseTreeCt, id), validIds);
      const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
      const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null);
      const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout);
      const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
      const recentlyClosedChatTabs = s.chats.some((c2) => c2.id === id) ? [{ id, at: Date.now() }, ...s.recentlyClosedChatTabs.filter((r) => r.id !== id)].slice(0, 8) : s.recentlyClosedChatTabs;
      return { openChatIds, activeChatId, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
    });
    persistSoon();
  },
  closeInactiveChatTabs: () => {
    let closed = [];
    set((s) => {
      const streaming = new Set(
        s.chats.filter((c2) => c2.messages.some((m) => m.streaming || m.retry?.reconnecting === true)).map((c2) => c2.id)
      );
      const visible = new Set(s.chatTree ? collectChatIds(s.chatTree) : s.visibleChatIds);
      const toClose = s.openChatIds.filter(
        (id) => id !== s.activeChatId && !streaming.has(id) && !visible.has(id)
      );
      if (toClose.length === 0) return {};
      closed = toClose;
      const drop = new Set(toClose);
      const openChatIds = s.openChatIds.filter((cid) => !drop.has(cid));
      persistOpenState(openChatIds, s.activeChatId);
      const validIds = new Set(s.chats.map((c2) => c2.id));
      let baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
      for (const id of toClose) {
        if (!baseTreeCt) break;
        baseTreeCt = removeChat(baseTreeCt, id);
      }
      const normalizedCt = normalizeTree(baseTreeCt, validIds);
      const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !drop.has(cid)), validIds, s.activeChatId);
      const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null);
      const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout);
      const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
      const now = Date.now();
      const kept = toClose.filter((id) => s.chats.some((c2) => c2.id === id));
      const recentlyClosedChatTabs = [
        ...kept.map((id, i) => ({ id, at: now - i })),
        ...s.recentlyClosedChatTabs.filter((r) => !drop.has(r.id))
      ].slice(0, 8);
      return { openChatIds, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
    });
    persistSoon();
    return closed;
  },
  reopenChatTab: (id) => {
    set((s) => ({
      recentlyClosedChatTabs: s.recentlyClosedChatTabs.filter((r) => r.id !== id)
    }));
    get().openChat(id);
  },
  moveChatTab: (fromId, toId, after = false) => {
    set((s) => {
      const from = s.openChatIds.indexOf(fromId);
      if (from === -1 || !s.openChatIds.includes(toId) || fromId === toId) return {};
      const rest = s.openChatIds.filter((cid) => cid !== fromId);
      let dest = rest.indexOf(toId) + (after ? 1 : 0);
      dest = Math.max(0, Math.min(rest.length, dest));
      const openChatIds = rest.slice();
      openChatIds.splice(dest, 0, fromId);
      persistOpenState(openChatIds, fromId);
      return {
        openChatIds,
        activeChatId: fromId,
        unreadChats: s.unreadChats.filter((cid) => cid !== fromId)
      };
    });
    persistSoon();
  },
  openInWindow: (id) => {
    set((s) => {
      if (!s.chats.some((c2) => c2.id === id)) return {};
      const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [s.activeChatId], s.chatLayout);
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
      persistOpenState(openChatIds, id);
      const chatTree = containsChat(base, id) ? base : openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds: mirrors.visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        unreadChats: s.unreadChats.filter((cid) => cid !== id)
      };
    });
    persistSoon();
  },
  closeWindow: (id) => {
    set((s) => {
      const treeIds = s.chatTree ? collectChatIds(s.chatTree) : [];
      const ids = treeIds.length > 0 ? treeIds : s.visibleChatIds;
      if (!ids.includes(id) && !s.visibleChatIds.includes(id)) return {};
      if ((/* @__PURE__ */ new Set([...treeIds, ...s.visibleChatIds])).size <= 1 && ids.length <= 1) return {};
      const idx = ids.indexOf(id);
      const base = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
      const pruned = removeChat(base, id);
      const fallbackVisible = (s.visibleChatIds.length > 0 ? s.visibleChatIds : ids).filter((cid) => cid !== id);
      const chatTree = pruned ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null);
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
      let activeChatId = s.activeChatId;
      if (s.activeChatId === id) {
        activeChatId = visibleChatIds[Math.min(Math.max(idx, 0), visibleChatIds.length - 1)] ?? "";
      }
      if (activeChatId !== s.activeChatId) persistOpenState(s.openChatIds, activeChatId);
      const windowFullscreenId = s.windowFullscreenId === id ? null : s.windowFullscreenId;
      if (s.windowFullscreenId === id) persistWindowFullscreen(null);
      return {
        visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        activeChatId,
        windowFullscreenId,
        unreadChats: s.unreadChats.filter((cid) => cid !== activeChatId)
      };
    });
  },
  focusWindow: (id) => {
    set((s) => {
      if (!s.chats.some((c2) => c2.id === id)) return {};
      if (s.activeChatId === id) return {};
      const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
      persistOpenState(openChatIds, id);
      let chatTree = s.chatTree;
      let visibleChatIds = s.visibleChatIds;
      let chatWindowSizes = s.chatWindowSizes;
      let chatLayout = s.chatLayout;
      if (!containsChat(chatTree, id)) {
        if (leafCount(chatTree) <= 1 && visibleChatIds.length <= 1) {
          visibleChatIds = [id];
          chatTree = null;
          persistVisibleChats(visibleChatIds);
          persistChatTree(null);
        } else {
          const base = ensureTree(chatTree, visibleChatIds, s.chatLayout);
          chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          visibleChatIds = mirrors.visibleChatIds;
          chatWindowSizes = mirrors.chatWindowSizes;
          chatLayout = mirrors.chatLayout;
        }
      }
      return {
        activeChatId: id,
        openChatIds,
        visibleChatIds,
        chatTree,
        chatWindowSizes,
        chatLayout,
        unreadChats: s.unreadChats.filter((cid) => cid !== id)
      };
    });
    persistSoon();
  },
  moveWindow: (fromId, toId, after = false) => {
    set((s) => {
      if (s.chatTree) {
        const base = ensureTree(s.chatTree, s.visibleChatIds, s.chatLayout);
        if (!base) return {};
        const flatDir = base.kind === "split" ? base.dir : treeDirFromLayout(s.chatLayout);
        const isFlat = base.kind !== "split" || base.children.every((c2) => c2.kind === "leaf");
        const root = isFlat && base.kind === "split" ? base : buildFromList(collectChatIds(base), flatDir);
        if (!root || root.kind !== "split") return {};
        const ids = collectChatIds(root);
        if (!ids.includes(fromId) || !ids.includes(toId) || fromId === toId) return {};
        const rest2 = ids.filter((cid) => cid !== fromId);
        let dest2 = rest2.indexOf(toId) + (after ? 1 : 0);
        dest2 = Math.max(0, Math.min(rest2.length, dest2));
        const ordered = rest2.slice();
        ordered.splice(dest2, 0, fromId);
        const sizes = sizesByChat(base);
        const chatTree = buildFromList(ordered, root.dir, sizes);
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
        return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
      }
      const from = s.visibleChatIds.indexOf(fromId);
      if (from === -1 || !s.visibleChatIds.includes(toId) || fromId === toId) return {};
      const rest = s.visibleChatIds.filter((cid) => cid !== fromId);
      let dest = rest.indexOf(toId) + (after ? 1 : 0);
      dest = Math.max(0, Math.min(rest.length, dest));
      const visibleChatIds = rest.slice();
      visibleChatIds.splice(dest, 0, fromId);
      persistVisibleChats(visibleChatIds);
      return { visibleChatIds };
    });
    persistSoon();
  },
  setWindowSize: (id, size) => {
    const clamped = Number.isFinite(size) ? Math.max(0.25, Math.min(4, size)) : 1;
    set((s) => {
      const ids = s.chatTree ? collectChatIds(s.chatTree) : s.visibleChatIds;
      if (!ids.includes(id)) return {};
      if (s.chatTree) {
        const chatTree = setChatSize(s.chatTree, id, clamped);
        const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
        return { chatTree, chatWindowSizes: mirrors.chatWindowSizes, visibleChatIds: mirrors.visibleChatIds, chatLayout: mirrors.chatLayout };
      }
      const chatWindowSizes = { ...s.chatWindowSizes, [id]: clamped };
      persistWindowSizes(chatWindowSizes);
      return { chatWindowSizes };
    });
  },
  setChatLayout: (layout) => {
    const next = normalizeChatLayout(layout);
    set((s) => {
      if (s.chatTree && s.chatTree.kind === "split") {
        const chatTree = setRootDir(s.chatTree, next === "horizontal" ? "row" : "col");
        const mirrors = persistTreeMirrors(chatTree, next);
        return { chatLayout: mirrors.chatLayout, chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes };
      }
      persistChatLayout(next);
      return { chatLayout: next };
    });
  },
  dropChatOnto: (dragChatId, targetChatId, pos) => {
    if (!dragChatId || !targetChatId) return;
    if (dragChatId === targetChatId) return;
    set((s) => {
      if (!s.chats.some((c2) => c2.id === dragChatId)) return {};
      if (!s.chats.some((c2) => c2.id === targetChatId)) return {};
      const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [targetChatId], s.chatLayout);
      if (base && !containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX && pos !== "center") {
        const openChatIds2 = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
        persistOpenState(openChatIds2, s.activeChatId);
        return { openChatIds: openChatIds2 };
      }
      const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
      persistOpenState(openChatIds, dragChatId);
      const chatTree = dropOnto(base, dragChatId, targetChatId, pos);
      if (!chatTree) return {};
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      if (s.windowFullscreenId) persistWindowFullscreen(null);
      return {
        activeChatId: dragChatId,
        openChatIds,
        visibleChatIds: mirrors.visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        windowFullscreenId: null,
        unreadChats: s.unreadChats.filter((cid) => cid !== dragChatId)
      };
    });
    persistSoon();
  },
  dropChatOntoRoot: (dragChatId, pos) => {
    if (!dragChatId) return;
    if (pos === "center") return;
    set((s) => {
      if (!s.chats.some((c2) => c2.id === dragChatId)) return {};
      const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [dragChatId], s.chatLayout);
      if (!base) return {};
      if (!containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX) {
        const openChatIds2 = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
        persistOpenState(openChatIds2, s.activeChatId);
        return { openChatIds: openChatIds2 };
      }
      const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
      persistOpenState(openChatIds, dragChatId);
      const chatTree = dropOntoRoot(base, dragChatId, pos);
      if (!chatTree || chatTree === base) return { openChatIds };
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      if (s.windowFullscreenId) persistWindowFullscreen(null);
      return {
        activeChatId: dragChatId,
        openChatIds,
        visibleChatIds: mirrors.visibleChatIds,
        chatWindowSizes: mirrors.chatWindowSizes,
        chatLayout: mirrors.chatLayout,
        chatTree,
        windowFullscreenId: null,
        unreadChats: s.unreadChats.filter((cid) => cid !== dragChatId)
      };
    });
    persistSoon();
  },
  setTreeNodeSize: (nodeId, size) => {
    set((s) => {
      if (!s.chatTree) return {};
      const chatTree = setNodeSize(s.chatTree, nodeId, size);
      if (!chatTree || chatTree === s.chatTree) return {};
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
    });
  },
  resizeTreePair: (parentId, firstId, secondId, firstSize, secondSize) => {
    set((s) => {
      if (!s.chatTree) return {};
      const chatTree = resizePair(s.chatTree, parentId, firstId, secondId, firstSize, secondSize);
      if (!chatTree || chatTree === s.chatTree) return {};
      const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
      return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
    });
  },
  setChatFullscreen: (v) => {
    set(() => {
      persistChatFullscreen(v);
      return { chatFullscreen: v };
    });
  },
  toggleChatFullscreen: () => {
    set((s) => {
      persistChatFullscreen(!s.chatFullscreen);
      return { chatFullscreen: !s.chatFullscreen };
    });
  },
  setWindowFullscreen: (id) => {
    persistWindowFullscreen(id);
    set({ windowFullscreenId: id });
  },
  toggleWindowFullscreen: (id) => {
    const st = get();
    const target = id ?? st.activeChatId;
    if (!target) return;
    const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
    if (ids.length < 2 && !st.windowFullscreenId) return;
    const next = toggleFullscreenId(st.windowFullscreenId, target);
    persistWindowFullscreen(next);
    if (next && st.activeChatId !== next) {
      const openChatIds = st.openChatIds.includes(next) ? st.openChatIds : [...st.openChatIds, next];
      persistOpenState(openChatIds, next);
      set({ windowFullscreenId: next, activeChatId: next, openChatIds, unreadChats: st.unreadChats.filter((cid) => cid !== next) });
    } else {
      set({ windowFullscreenId: next });
    }
  },
  setChatMode: (id, mode) => {
    if (!isChatBodyReady(id)) return;
    set((s) => ({
      chats: s.chats.map((c2) => {
        if (c2.id !== id) return c2;
        const label = MODE_LABELS[mode] ?? mode;
        const modeMsg = {
          id: uid(),
          role: "system",
          content: `[Mode switched to ${label} \u2014 the next user message runs in ${label} mode.]`,
          modeSwitch: true,
          createdAt: Date.now()
        };
        return { ...c2, mode, messages: [...c2.messages, modeMsg], updatedAt: Date.now() };
      })
    }));
    get().persist();
  },
  setChatModeQuiet: (id, mode) => {
    if (!isChatBodyReady(id)) return;
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, mode, updatedAt: Date.now() } : c2)
    }));
    get().persist();
  },
  setGoal: (id, condition) => {
    const text = (condition ?? "").trim();
    if (!text) return;
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id ? { ...c2, goal: { condition: text, active: true, paused: false, stopped: false, startedAt: Date.now(), turns: 0 }, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  clearGoal: (id) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, goal: null, updatedAt: Date.now() } : c2)
    }));
    get().persist();
  },
  pauseGoal: (id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id && c2.goal?.active ? { ...c2, goal: { ...c2.goal, paused: true, stopped: false }, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  resumeGoal: (id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id && c2.goal?.active ? { ...c2, goal: { ...c2.goal, paused: false, stopped: false }, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  stopGoal: (id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id && c2.goal?.active && !c2.goal.paused ? { ...c2, goal: { ...c2.goal, stopped: true }, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  rearmGoal: (id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id && c2.goal?.active && c2.goal.stopped ? { ...c2, goal: { ...c2.goal, stopped: false }, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  incrementGoalTurn: (id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id && c2.goal?.active && !c2.goal.paused ? { ...c2, goal: { ...c2.goal, turns: (c2.goal.turns ?? 0) + 1 } } : c2
      )
    }));
    get().persist();
  },
  setChatRoot: (id, root) => {
    set((s) => ({
      root: s.activeChatId === id ? root : s.root,
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, root, updatedAt: Date.now() } : c2)
    }));
    get().persist();
  },
  setChatDraft: (id, patch) => {
    set((s) => {
      const idx = s.chats.findIndex((c2) => c2.id === id);
      if (idx === -1) return {};
      const cur = s.chats[idx];
      const next = { ...cur.draft, ...patch };
      const prev = cur.draft ?? {};
      const keys = /* @__PURE__ */ new Set([...Object.keys(prev), ...Object.keys(next)]);
      let changed = false;
      for (const k of keys) {
        if (prev[k] !== next[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return {};
      const chats = s.chats.slice();
      chats[idx] = { ...cur, draft: next };
      return { chats };
    });
  },
  setChatThinkingLevel: (id, level) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, thinkingLevel: level, updatedAt: Date.now() } : c2)
    }));
    get().persist();
  },
  setChatProvider: (id, providerId, model) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, providerId, model, updatedAt: Date.now() } : c2)
    }));
    get().persist();
  },
  renameChat: (id, title) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, title, updatedAt: Date.now() } : c2)
    }));
    get().persist();
  },
  forkSection: (messageId, sectionTitle, sectionContent) => {
    const s = useStore2.getState();
    const src = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
    if (!src) return;
    const chatId = s.newChatInRoot(src.root ?? "", src.mode);
    if (src.providerId) {
      useStore2.getState().setChatProvider(chatId, src.providerId, src.model ?? "");
    }
    const label = sectionTitle.trim() || "\u0628\u062E\u0634";
    const context = `\u{1F4CC} \u0628\u062E\u0634 \xAB${label}\xBB \u0627\u0632 \u067E\u0627\u0633\u062E \u0642\u0628\u0644\u06CC:

${sectionContent.trim()}`;
    useStore2.getState().addMessage(chatId, { role: "user", content: context });
    useStore2.getState().renameChat(chatId, label);
    useStore2.getState().setFocusComposer(true);
  },
  setFocusComposer: (v) => set({ focusComposer: v }),
  forkChatFromMessage: (messageId) => {
    const src = get().chats.find((c2) => c2.messages.some((m) => m.id === messageId));
    if (!src) return null;
    const idx = src.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    const chatId = get().newChatInRoot(src.root ?? "", src.mode);
    if (src.providerId) {
      get().setChatProvider(chatId, src.providerId, src.model ?? "");
    }
    const seed = forkSeedMessage(src, idx);
    set((st) => ({
      chats: st.chats.map(
        (c2) => c2.id === chatId ? {
          ...c2,
          messages: [seed],
          // 'New chat' (not "(fork)") on purpose: the title generator only
          // fires while the title is still the untouched placeholder, so
          // the user's FIRST new message here renames the fork for real.
          title: "New chat",
          thinkingLevel: src.thinkingLevel,
          updatedAt: Date.now()
        } : c2
      ),
      activeChatId: chatId
    }));
    get().persist();
    get().setFocusComposer(true);
    return chatId;
  },
  addMessage: (chatId, message) => {
    if (!isChatBodyReady(chatId)) {
      throw new Error("chat body not hydrated");
    }
    const id = uid();
    const full = { ...message, id, createdAt: Date.now() };
    const prev = get().chats.find((c2) => c2.id === chatId);
    const autoTitle = capTitleWords(message.content);
    const hasPriorUser = !!prev?.messages.some((m) => m.role === "user");
    const shouldTitle = message.role === "user" && !!prev && !hasPriorUser && prev.title === "New chat" && message.content.trim() !== "";
    set((s) => {
      if (message.role === "user") {
        const st = stackFor(chatId);
        st.redo = [];
      }
      const chats = s.chats.map(
        (c2) => c2.id === chatId ? {
          ...c2,
          messages: [...c2.messages, full],
          // The sidebar sorts by the most recent message activity: sending
          // a user message, or a completed assistant reply, floats the
          // chat to the top of its group. Streaming assistant deltas stay
          // put mid-run so two concurrent chats don't keep swapping places
          // while the agent streams — the final setStreaming(false) bumps.
          updatedAt: !message.streaming && (message.role === "user" || message.role === "assistant") ? Date.now() : c2.updatedAt,
          title: c2.messages.length === 0 && message.role === "user" ? autoTitle : c2.title
        } : c2
      );
      return { chats };
    });
    get().persist();
    if (shouldTitle) {
      console.info("[title] generating title for new chat", chatId.slice(-6));
      void (async () => {
        try {
          const st = get();
          const chat = st.chats.find((c2) => c2.id === chatId);
          const provider = st.settings.providers.find(
            (p) => p.id === (chat?.providerId ?? st.settings.activeProviderId)
          ) ?? st.settings.providers[0];
          if (!provider) return;
          const res = await requestChatTitle({
            provider,
            subagentModels: st.subagentModels ?? {},
            subagentThinking: st.subagentThinking ?? {},
            toolFallbacks: toolFallbackEntries(st.toolFallbacks),
            providers: Object.fromEntries(
              (st.settings.providers ?? []).map((p) => [p.id, p])
            ),
            // Mirror the main call's gate: a model that is not known to reason
            // must not have a reasoning parameter forced onto it.
            modelReasoning: modelReasoning(provider, provider.model) ?? supportsReasoning(provider.model, provider.kind),
            text: message.content.slice(0, 1e3),
            chatId
          });
          const title = capTitleWords(typeof res?.title === "string" ? res.title : "");
          if (title) {
            try {
              const cur = get().chats.find((c2) => c2.id === chatId);
              if (!cur) {
                console.info("[title] chat gone \u2014 skipping apply");
              } else if (cur.title !== "New chat" && cur.title !== autoTitle && (cur.title || "").trim() !== "") {
                console.info("[title] title changed meanwhile \u2014 keeping it:", cur.title);
              } else {
                get().renameChat(chatId, title);
                console.info("[title] applied title:", title, chatId.slice(-6));
              }
            } catch (err) {
              console.warn("[title] apply failed \u2014 keeping auto title", err);
            }
          }
          const cu = res?.usage;
          if (cu) {
            try {
              const pid = cu.provider_id || cu.provider || provider.id;
              const usageModel = normalizeUsageModel(pid, cu.model || provider.model || "main");
              get().accrueChatUsage(chatId, pid, usageModel, {
                input: cu.input_tokens ?? 0,
                output: cu.output_tokens ?? 0,
                cacheRead: cu.cache_read_tokens ?? 0,
                cacheWrite: cu.cache_write_tokens ?? 0
              });
            } catch (err) {
              console.warn("[title] usage accrue failed", err);
            }
          }
        } catch (err) {
          console.warn("[title] title flow failed \u2014 keeping auto title", err);
        }
      })();
    } else if (message.role === "user" && !!prev && !hasPriorUser && message.content.trim() !== "") {
      if (prev.title !== autoTitle) {
        console.info("[title] trigger skipped \u2014 current title:", prev.title, chatId.slice(-6));
      } else {
        console.debug("[title] trigger skipped \u2014 title already matches first message", chatId.slice(-6));
      }
    }
    return full;
  },
  removeMessage: (chatId, id) => {
    if (!isChatBodyReady(chatId)) return;
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === chatId ? { ...c2, messages: c2.messages.filter((m) => m.id !== id) } : c2
      )
    }));
    get().persist();
  },
  queueMessage: (chatId, msg) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === chatId ? { ...c2, queued: [...c2.queued ?? [], { ...msg, createdAt: Date.now() }] } : c2
      )
    }));
    get().persist();
  },
  removeQueuedMessage: (chatId, id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === chatId ? { ...c2, queued: (c2.queued ?? []).filter((q) => q.id !== id) } : c2
      )
    }));
    get().persist();
  },
  clearQueue: (chatId) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === chatId ? { ...c2, queued: [] } : c2)
    }));
    get().persist();
  },
  markQueuedSent: (chatId, id) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === chatId ? { ...c2, queued: (c2.queued ?? []).map((q) => q.id === id ? { ...q, sent: true } : q) } : c2
      )
    }));
    get().persist();
  },
  updateMessage: (id, patch) => {
    set((s) => {
      const targetChat = s.chats.find((c2) => c2.messages.some((m) => m.id === id));
      if (!targetChat) return {};
      const msg = targetChat.messages.find((m) => m.id === id);
      const completes = msg.streaming === true && patch.streaming === false;
      const updatedChat = {
        ...targetChat,
        messages: targetChat.messages.map((m) => m.id === id ? { ...m, ...patch } : m),
        updatedAt: completes ? Date.now() : targetChat.updatedAt
      };
      const unreadChats = completes && targetChat.id !== s.activeChatId && !s.unreadChats.includes(targetChat.id) ? [...s.unreadChats, targetChat.id] : s.unreadChats;
      return {
        chats: s.chats.map((c2) => c2.id === targetChat.id ? updatedChat : c2),
        unreadChats
      };
    });
    maybePersistMidStream();
  },
  appendMessageSegments: (id, segments) => {
    if (!segments || segments.length === 0) return false;
    let added = false;
    set((s) => {
      const targetChat = s.chats.find((c2) => c2.messages.some((m) => m.id === id));
      if (!targetChat) return {};
      const msg = targetChat.messages.find((m) => m.id === id);
      const cur = msg.segments ?? [];
      const next = [...cur];
      for (const seg of segments) {
        const dup = next.some((e) => {
          if (e.kind !== seg.kind) return false;
          if (seg.kind === "user" && e.kind === "user") return e.id === seg.id;
          if (seg.kind === "compact" && e.kind === "compact") return e.id === seg.id;
          if (seg.kind === "tool" && e.kind === "tool")
            return e.index === seg.index;
          return false;
        });
        if (!dup) {
          next.push(seg);
          added = true;
        }
      }
      if (!added) return {};
      return {
        chats: s.chats.map(
          (c2) => c2.id === targetChat.id ? {
            ...c2,
            messages: c2.messages.map(
              (m) => m.id === id ? { ...m, segments: next } : m
            )
          } : c2
        )
      };
    });
    if (added) maybePersistMidStream();
    return added;
  },
  accrueChatUsage: (chatId, providerId, model, delta) => {
    const hasTokens = (delta.input || 0) > 0 || (delta.output || 0) > 0 || (delta.cacheRead || 0) > 0 || (delta.cacheWrite || 0) > 0;
    if (!hasTokens) return;
    set((s) => ({
      chats: s.chats.map((c2) => {
        if (c2.id !== chatId) return c2;
        const entries = [...c2.usage?.entries ?? []];
        const idx = entries.findIndex(
          (e) => e.providerId === providerId && e.model === model
        );
        if (idx >= 0) {
          const prev = entries[idx];
          entries[idx] = {
            ...prev,
            input: prev.input + (delta.input || 0),
            output: prev.output + (delta.output || 0),
            cacheRead: (prev.cacheRead ?? 0) + (delta.cacheRead ?? 0),
            cacheWrite: (prev.cacheWrite ?? 0) + (delta.cacheWrite ?? 0),
            lastUsed: Date.now()
          };
        } else {
          entries.push({
            providerId,
            model,
            input: delta.input || 0,
            output: delta.output || 0,
            cacheRead: delta.cacheRead ?? 0,
            cacheWrite: delta.cacheWrite ?? 0,
            lastUsed: Date.now()
          });
        }
        const working = c2.messages.some((m) => m.streaming);
        return { ...c2, usage: { entries }, updatedAt: working ? c2.updatedAt : Date.now() };
      })
    }));
    persistSoon();
  },
  resetChatUsage: (chatId) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === chatId ? { ...c2, usage: void 0, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  setChatPendingAsk: (chatId, req) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === chatId ? { ...c2, pendingAsk: req } : c2)
    }));
  },
  setChatPendingPermission: (chatId, req) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === chatId ? { ...c2, pendingPermission: req } : c2)
    }));
  },
  setChatCompacting: (id, compacting) => {
    set((s) => ({
      chats: s.chats.map(
        (c2) => (
          // Clearing the flag also drops the progress, so a later compaction can
          // never inherit a stale phase/elapsed pair from the previous run.
          c2.id === id ? { ...c2, compacting, compactProgress: compacting ? c2.compactProgress : null } : c2
        )
      )
    }));
  },
  setChatCompactProgress: (id, compactProgress) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, compactProgress } : c2)
    }));
  },
  setChatCompactNotice: (id, compactNotice) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, compactNotice } : c2)
    }));
  },
  setChatCompactError: (id, compactError) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, compactError } : c2)
    }));
  },
  setChatCmdError: (id, cmdError) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, cmdError } : c2)
    }));
  },
  setChatLiveError: (id, liveError) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, liveError } : c2)
    }));
  },
  setChatTtsError: (id, ttsError) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, ttsError } : c2)
    }));
  },
  setChatSkillNotice: (id, skillNotice) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, skillNotice } : c2)
    }));
  },
  setChatUndoNotice: (id, undoNotice) => {
    set((s) => ({
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, undoNotice } : c2)
    }));
  },
  docRev: {},
  bumpDocRev: (absPath) => {
    set((s) => ({
      docRev: { ...s.docRev, [absPath]: (s.docRev[absPath] ?? 0) + 1 }
    }));
  },
  setChatScrollPos: (id, pos) => {
    set((s) => ({
      // Deliberately NOT bumping updatedAt: scrolling shouldn't reorder chats.
      chats: s.chats.map((c2) => c2.id === id ? { ...c2, scrollPos: pos } : c2)
    }));
    get().persist();
  },
  // In-memory-only variant: updates the store WITHOUT persisting. Used by the
  // `coder:flush-ui` handler so a chat panel can push its ref-held scroll
  // position into the store right before a flush writes the snapshot — no
  // redundant write, no recursion into persist().
  setChatScrollPosMem: (id, pos) => {
    set((s) => {
      const cur = s.chats.find((c2) => c2.id === id)?.scrollPos ?? null;
      const same = cur === null && pos === null || cur !== null && pos !== null && cur.id === pos.id && cur.offset === pos.offset && cur.atBottom === pos.atBottom;
      if (same) return {};
      return {
        chats: s.chats.map((c2) => c2.id === id ? { ...c2, scrollPos: pos } : c2)
      };
    });
  },
  setPrefixNotice: (prefixNotice) => {
    set({ prefixNotice });
  },
  markToolReverted: (messageId, index) => {
    set((s) => ({
      chats: s.chats.map((c2) => {
        const has = c2.messages.some((m) => m.id === messageId);
        if (!has) return c2;
        return {
          ...c2,
          messages: c2.messages.map(
            (m) => m.id === messageId ? {
              ...m,
              toolActivity: (m.toolActivity ?? []).map(
                (act, i) => i === index ? { ...act, reverted: true } : act
              )
            } : m
          ),
          updatedAt: Date.now()
        };
      })
    }));
    persistSoon();
  },
  clearChat: (id) => {
    if (!isChatBodyReady(id)) return;
    abortChatStream(get().chatAborts[id]);
    historyStacks.delete(id);
    set((s) => ({
      chats: s.chats.map(
        (c2) => c2.id === id ? { ...c2, messages: [], usage: void 0, updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
  },
  truncateTo: (messageId) => {
    const s = get();
    const target = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
    if (!target) return false;
    const idx = target.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    const targetId = target.id;
    set((st) => ({
      chats: st.chats.map(
        (c2) => c2.id === targetId ? { ...c2, messages: c2.messages.slice(0, idx), updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
    return true;
  },
  compactChat: (id, summary, keep = 0) => {
    if (!isChatBodyReady(id)) return;
    set((s) => ({
      chats: s.chats.map((c2) => {
        if (c2.id !== id) return c2;
        const nonSys = c2.messages.filter((m) => m.role !== "system");
        const recentStart = Math.max(nonSys.length - keep, 0);
        const compactedIds = new Set(
          nonSys.slice(0, recentStart).map((m) => m.id)
        );
        for (const m of c2.messages) {
          if (m.streaming) compactedIds.delete(m.id);
        }
        for (const m of c2.messages) {
          if (m.role === "system") compactedIds.add(m.id);
        }
        const messages = c2.messages.map(
          (m) => compactedIds.has(m.id) ? { ...m, compacted: true } : { ...m, usage: void 0 }
        );
        const summaryMsg = {
          id: uid(),
          role: "system",
          content: summary,
          usage: void 0,
          compacted: false,
          createdAt: Date.now()
        };
        const streaming = messages.find((m) => m.streaming);
        const withSeg = streaming ? messages.map(
          (m) => m.id === streaming.id ? {
            ...m,
            segments: [
              ...m.segments ?? [],
              { kind: "compact", id: summaryMsg.id }
            ]
          } : m
        ) : messages;
        withSeg.push(summaryMsg);
        return {
          ...c2,
          messages: withSeg,
          updatedAt: Date.now()
        };
      })
    }));
    get().persist();
  },
  undoMessage: () => {
    const s = get();
    const chat = s.chats.find((c2) => c2.id === s.activeChatId);
    if (!chat || chat.messages.length === 0) return false;
    if (chat.messages.some((m) => m.streaming)) {
      abortChatStream(s.chatAborts[chat.id]);
      return false;
    }
    let idx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx === -1) return false;
    const removed = chat.messages.slice(idx);
    const st = stackFor(chat.id);
    st.redo.push(removed);
    if (st.redo.length > MAX_REDO_EXCHANGES) {
      st.redo.splice(0, st.redo.length - MAX_REDO_EXCHANGES);
    }
    set((stt) => ({
      chats: stt.chats.map(
        (c2) => c2.id === chat.id ? { ...c2, messages: c2.messages.slice(0, idx), updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
    return true;
  },
  redoMessage: () => {
    const s = get();
    const chat = s.chats.find((c2) => c2.id === s.activeChatId);
    if (!chat) return false;
    if (chat.messages.some((m) => m.streaming)) return false;
    const st = stackFor(chat.id);
    const exchange = st.redo.pop();
    if (!exchange) return false;
    set((stt) => ({
      chats: stt.chats.map(
        (c2) => c2.id === chat.id ? { ...c2, messages: [...c2.messages, ...exchange], updatedAt: Date.now() } : c2
      )
    }));
    get().persist();
    return true;
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setStreaming: (active, thinking) => set((s) => {
    if (s.isStreaming === active && s.isThinking === thinking) return {};
    return { isStreaming: active, isThinking: thinking };
  }),
  setOutsideAllowed: (allowed) => set({ outsideAllowed: allowed }),
  addOutsideFolder: (folder) => set((s) => ({
    outsideFolders: folder && !s.outsideFolders.includes(folder) ? [...s.outsideFolders, folder] : s.outsideFolders
  })),
  setComputerUse: (v) => set({ computerUse: v }),
  setBrowserUse: (v) => set({ browserUse: v }),
  anyStreaming: () => get().chats.some((c2) => c2.messages.some((m) => m.streaming)),
  setCompactAtPercent: (percent) => {
    set((s) => ({ settings: { ...s.settings, compactAtPercent: percent } }));
    get().persist();
  },
  setDisableTextSuggestions: (on) => {
    set((s) => ({ settings: { ...s.settings, disableTextSuggestions: on } }));
    get().persist();
  },
  setNvimTerminal: (id) => {
    set((s) => ({ settings: { ...s.settings, nvimTerminal: resolveNvimTerminal(id) } }));
    get().persist();
  },
  setTerminalShell: (shell2) => {
    const picked = (shell2 ?? "").trim();
    set((s) => ({
      settings: { ...s.settings, terminalShell: picked || DEFAULT_TERMINAL_SHELL }
    }));
    get().persist();
  }
}));
api.onSidecarChanged(() => {
  void useStore2.getState().load();
});

// src/components/ArtifactPanel.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function isMcpRequest(data) {
  if (!data || typeof data !== "object") return false;
  const msg = data;
  return msg.source === "codifa-artifact" && typeof msg.id === "number" && typeof msg.tool === "string" && msg.tool.trim().length > 0;
}
function ArtifactPanel({
  title,
  kind,
  body,
  chatId,
  id
}) {
  const missing = !body.trim();
  const [fetched, setFetched] = (0, import_react2.useState)("");
  const [error, setError] = (0, import_react2.useState)("");
  const [assets, setAssets] = (0, import_react2.useState)([]);
  const frameRef = (0, import_react2.useRef)(null);
  const mcpServers = useStore2((st) => st.settings.mcpServers ?? {});
  const mcpEnabled = useStore2((st) => st.settings.mcpEnabled ?? []);
  const enabledServers = (0, import_react2.useMemo)(() => {
    const sel = {};
    for (const n of mcpEnabled) if (mcpServers[n]) sel[n] = mcpServers[n];
    return sel;
  }, [mcpServers, mcpEnabled]);
  (0, import_react2.useEffect)(() => {
    if (!missing) {
      setFetched("");
      setError("");
      return;
    }
    if (!chatId || !id) return;
    let cancelled = false;
    void getArtifact(chatId, id).then((out) => {
      if (cancelled) return;
      if ("error" in out) setError(out.error);
      else setFetched(out.content);
    });
    return () => {
      cancelled = true;
    };
  }, [missing, chatId, id]);
  (0, import_react2.useEffect)(() => {
    if (!chatId || !id) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    void getArtifactAssets(chatId, id).then((out) => {
      if (cancelled) return;
      setAssets("error" in out ? [] : out.files);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, id, body]);
  (0, import_react2.useEffect)(() => {
    const onMessage = (event) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!isMcpRequest(data)) return;
      const reply = (payload) => frame.contentWindow?.postMessage(
        { source: "codifa-artifact-reply", id: data.id, ...payload },
        "*"
      );
      void callMcpTool(data.tool, data.args, enabledServers).then((out) => {
        if ("error" in out) reply({ ok: false, error: out.error });
        else reply({ ok: true, result: out.result });
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabledServers]);
  const doc = body.trim() ? body : fetched;
  if (!doc.trim()) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "artifact-panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "artifact-panel-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "artifact-panel-title", children: title }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "viewer-empty", children: error ? `Could not load this artifact's content: ${error}` : missing && chatId && id ? "Loading artifact\u2026" : "This artifact's content is no longer in memory \u2014 reopen it from its card in the chat." })
    ] });
  }
  if (kind === "md") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "artifact-panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "artifact-panel-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "artifact-panel-title", children: title }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "artifact-panel-md markdown-body", dir: "auto", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_markdown.default, { remarkPlugins: [import_remark_gfm.default], children: doc }) })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "artifact-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "artifact-panel-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "artifact-panel-title", children: title }),
      assets.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "artifact-panel-assets", title: assets.map((a) => a.path).join("\n"), children: [
        assets.length,
        " file",
        assets.length === 1 ? "" : "s"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "iframe",
      {
        ref: frameRef,
        className: "artifact-panel-frame",
        title,
        sandbox: "allow-scripts",
        srcDoc: doc
      }
    )
  ] });
}

// tests/artifactPanel.ssr.test.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var passed = 0;
var failures = [];
function check(name, cond, extra = "") {
  if (cond) passed++;
  else failures.push(extra ? `${name} - ${extra}` : name);
}
var html = (0, import_server.renderToString)(
  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    ArtifactPanel,
    {
      title: "Q3 dashboard",
      kind: "html",
      body: '<h1 id="x">Q3</h1>',
      chatId: "c1",
      id: "q3"
    }
  )
);
check("renders the artifact panel shell", html.includes("artifact-panel"));
check(
  "shows the artifact title",
  html.includes("artifact-panel-title") && html.includes("Q3 dashboard")
);
check(
  "renders the html body in the frame",
  html.includes("artifact-panel-frame") && /srcdoc=/i.test(html) && html.includes("id=&quot;x&quot;")
);
check(
  "sandbox allows scripts only",
  html.includes('sandbox="allow-scripts"') && !html.includes("allow-same-origin")
);
check("never renders markdown chrome for html", !html.includes("artifact-panel-md"));
var md = (0, import_server.renderToString)(
  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    ArtifactPanel,
    {
      title: "Q3 summary",
      kind: "md",
      body: "## Revenue\n\n- up 12%",
      chatId: "c1",
      id: "q3-md"
    }
  )
);
check(
  "markdown artifact uses the md container",
  md.includes("artifact-panel-md") && md.includes("markdown-body")
);
check("markdown artifact renders headings", md.includes("<h2") && md.includes("Revenue"));
check("markdown artifact renders list items", md.includes("<li") && md.includes("up 12%"));
check("markdown artifact has no frame", !md.includes("artifact-panel-frame"));
var empty = (0, import_server.renderToString)(/* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ArtifactPanel, { title: "Ghost", kind: "html", body: "" }));
check(
  "empty artifact explains itself",
  empty.includes("viewer-empty") && empty.includes("no longer in memory")
);
check("empty artifact renders no frame", !empty.includes("artifact-panel-frame"));
var pending = (0, import_server.renderToString)(
  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ArtifactPanel, { title: "Q3", kind: "html", body: "  ", chatId: "c1", id: "q3" })
);
check(
  "owned empty artifact does not claim loss while loading",
  !pending.includes("no longer in memory")
);
console.log(`${passed} artifact-panel checks passed`);
if (failures.length) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
/*! Bundled license information:

use-sync-external-store/cjs/use-sync-external-store-shim.production.js:
  (**
   * @license React
   * use-sync-external-store-shim.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

use-sync-external-store/cjs/use-sync-external-store-shim.development.js:
  (**
   * @license React
   * use-sync-external-store-shim.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js:
  (**
   * @license React
   * use-sync-external-store-shim/with-selector.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.development.js:
  (**
   * @license React
   * use-sync-external-store-shim/with-selector.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
