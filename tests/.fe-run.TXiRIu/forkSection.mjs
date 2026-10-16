var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// node_modules/zustand/esm/vanilla.mjs
var createStoreImpl, createStore;
var init_vanilla = __esm({
  "node_modules/zustand/esm/vanilla.mjs"() {
    createStoreImpl = (createState) => {
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
        if ((import.meta.env ? import.meta.env.MODE : void 0) !== "production") {
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
    createStore = (createState) => createState ? createStoreImpl(createState) : createStoreImpl;
  }
});

// node_modules/react/cjs/react.production.js
var require_react_production = __commonJS({
  "node_modules/react/cjs/react.production.js"(exports) {
    "use strict";
    var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element");
    var REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal");
    var REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment");
    var REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode");
    var REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler");
    var REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer");
    var REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context");
    var REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref");
    var REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense");
    var REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo");
    var REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy");
    var REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity");
    var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
    function getIteratorFn(maybeIterable) {
      if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
      maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
      return "function" === typeof maybeIterable ? maybeIterable : null;
    }
    var ReactNoopUpdateQueue = {
      isMounted: function() {
        return false;
      },
      enqueueForceUpdate: function() {
      },
      enqueueReplaceState: function() {
      },
      enqueueSetState: function() {
      }
    };
    var assign = Object.assign;
    var emptyObject = {};
    function Component(props, context, updater) {
      this.props = props;
      this.context = context;
      this.refs = emptyObject;
      this.updater = updater || ReactNoopUpdateQueue;
    }
    Component.prototype.isReactComponent = {};
    Component.prototype.setState = function(partialState, callback) {
      if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
        throw Error(
          "takes an object of state variables to update or a function which returns an object of state variables."
        );
      this.updater.enqueueSetState(this, partialState, callback, "setState");
    };
    Component.prototype.forceUpdate = function(callback) {
      this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
    };
    function ComponentDummy() {
    }
    ComponentDummy.prototype = Component.prototype;
    function PureComponent(props, context, updater) {
      this.props = props;
      this.context = context;
      this.refs = emptyObject;
      this.updater = updater || ReactNoopUpdateQueue;
    }
    var pureComponentPrototype = PureComponent.prototype = new ComponentDummy();
    pureComponentPrototype.constructor = PureComponent;
    assign(pureComponentPrototype, Component.prototype);
    pureComponentPrototype.isPureReactComponent = true;
    var isArrayImpl = Array.isArray;
    function noop() {
    }
    var ReactSharedInternals = { H: null, A: null, T: null, S: null };
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function ReactElement(type, key, props) {
      var refProp = props.ref;
      return {
        $$typeof: REACT_ELEMENT_TYPE,
        type,
        key,
        ref: void 0 !== refProp ? refProp : null,
        props
      };
    }
    function cloneAndReplaceKey(oldElement, newKey) {
      return ReactElement(oldElement.type, newKey, oldElement.props);
    }
    function isValidElement(object) {
      return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
    }
    function escape(key) {
      var escaperLookup = { "=": "=0", ":": "=2" };
      return "$" + key.replace(/[=:]/g, function(match) {
        return escaperLookup[match];
      });
    }
    var userProvidedKeyEscapeRegex = /\/+/g;
    function getElementKey(element, index) {
      return "object" === typeof element && null !== element && null != element.key ? escape("" + element.key) : index.toString(36);
    }
    function resolveThenable(thenable) {
      switch (thenable.status) {
        case "fulfilled":
          return thenable.value;
        case "rejected":
          throw thenable.reason;
        default:
          switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
            function(fulfilledValue) {
              "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
            },
            function(error) {
              "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
            }
          )), thenable.status) {
            case "fulfilled":
              return thenable.value;
            case "rejected":
              throw thenable.reason;
          }
      }
      throw thenable;
    }
    function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
      var type = typeof children;
      if ("undefined" === type || "boolean" === type) children = null;
      var invokeCallback = false;
      if (null === children) invokeCallback = true;
      else
        switch (type) {
          case "bigint":
          case "string":
          case "number":
            invokeCallback = true;
            break;
          case "object":
            switch (children.$$typeof) {
              case REACT_ELEMENT_TYPE:
              case REACT_PORTAL_TYPE:
                invokeCallback = true;
                break;
              case REACT_LAZY_TYPE:
                return invokeCallback = children._init, mapIntoArray(
                  invokeCallback(children._payload),
                  array,
                  escapedPrefix,
                  nameSoFar,
                  callback
                );
            }
        }
      if (invokeCallback)
        return callback = callback(children), invokeCallback = "" === nameSoFar ? "." + getElementKey(children, 0) : nameSoFar, isArrayImpl(callback) ? (escapedPrefix = "", null != invokeCallback && (escapedPrefix = invokeCallback.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
          return c;
        })) : null != callback && (isValidElement(callback) && (callback = cloneAndReplaceKey(
          callback,
          escapedPrefix + (null == callback.key || children && children.key === callback.key ? "" : ("" + callback.key).replace(
            userProvidedKeyEscapeRegex,
            "$&/"
          ) + "/") + invokeCallback
        )), array.push(callback)), 1;
      invokeCallback = 0;
      var nextNamePrefix = "" === nameSoFar ? "." : nameSoFar + ":";
      if (isArrayImpl(children))
        for (var i = 0; i < children.length; i++)
          nameSoFar = children[i], type = nextNamePrefix + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
            nameSoFar,
            array,
            escapedPrefix,
            type,
            callback
          );
      else if (i = getIteratorFn(children), "function" === typeof i)
        for (children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
          nameSoFar = nameSoFar.value, type = nextNamePrefix + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
            nameSoFar,
            array,
            escapedPrefix,
            type,
            callback
          );
      else if ("object" === type) {
        if ("function" === typeof children.then)
          return mapIntoArray(
            resolveThenable(children),
            array,
            escapedPrefix,
            nameSoFar,
            callback
          );
        array = String(children);
        throw Error(
          "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
        );
      }
      return invokeCallback;
    }
    function mapChildren(children, func, context) {
      if (null == children) return children;
      var result = [], count = 0;
      mapIntoArray(children, result, "", "", function(child) {
        return func.call(context, child, count++);
      });
      return result;
    }
    function lazyInitializer(payload) {
      if (-1 === payload._status) {
        var ctor = payload._result;
        ctor = ctor();
        ctor.then(
          function(moduleObject) {
            if (0 === payload._status || -1 === payload._status)
              payload._status = 1, payload._result = moduleObject;
          },
          function(error) {
            if (0 === payload._status || -1 === payload._status)
              payload._status = 2, payload._result = error;
          }
        );
        -1 === payload._status && (payload._status = 0, payload._result = ctor);
      }
      if (1 === payload._status) return payload._result.default;
      throw payload._result;
    }
    var reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
      if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
        var event = new window.ErrorEvent("error", {
          bubbles: true,
          cancelable: true,
          message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
          error
        });
        if (!window.dispatchEvent(event)) return;
      } else if ("object" === typeof process && "function" === typeof process.emit) {
        process.emit("uncaughtException", error);
        return;
      }
      console.error(error);
    };
    var Children = {
      map: mapChildren,
      forEach: function(children, forEachFunc, forEachContext) {
        mapChildren(
          children,
          function() {
            forEachFunc.apply(this, arguments);
          },
          forEachContext
        );
      },
      count: function(children) {
        var n = 0;
        mapChildren(children, function() {
          n++;
        });
        return n;
      },
      toArray: function(children) {
        return mapChildren(children, function(child) {
          return child;
        }) || [];
      },
      only: function(children) {
        if (!isValidElement(children))
          throw Error(
            "React.Children.only expected to receive a single React element child."
          );
        return children;
      }
    };
    exports.Activity = REACT_ACTIVITY_TYPE;
    exports.Children = Children;
    exports.Component = Component;
    exports.Fragment = REACT_FRAGMENT_TYPE;
    exports.Profiler = REACT_PROFILER_TYPE;
    exports.PureComponent = PureComponent;
    exports.StrictMode = REACT_STRICT_MODE_TYPE;
    exports.Suspense = REACT_SUSPENSE_TYPE;
    exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
    exports.__COMPILER_RUNTIME = {
      __proto__: null,
      c: function(size) {
        return ReactSharedInternals.H.useMemoCache(size);
      }
    };
    exports.cache = function(fn) {
      return function() {
        return fn.apply(null, arguments);
      };
    };
    exports.cacheSignal = function() {
      return null;
    };
    exports.cloneElement = function(element, config, children) {
      if (null === element || void 0 === element)
        throw Error(
          "The argument must be a React element, but you passed " + element + "."
        );
      var props = assign({}, element.props), key = element.key;
      if (null != config)
        for (propName in void 0 !== config.key && (key = "" + config.key), config)
          !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
      var propName = arguments.length - 2;
      if (1 === propName) props.children = children;
      else if (1 < propName) {
        for (var childArray = Array(propName), i = 0; i < propName; i++)
          childArray[i] = arguments[i + 2];
        props.children = childArray;
      }
      return ReactElement(element.type, key, props);
    };
    exports.createContext = function(defaultValue) {
      defaultValue = {
        $$typeof: REACT_CONTEXT_TYPE,
        _currentValue: defaultValue,
        _currentValue2: defaultValue,
        _threadCount: 0,
        Provider: null,
        Consumer: null
      };
      defaultValue.Provider = defaultValue;
      defaultValue.Consumer = {
        $$typeof: REACT_CONSUMER_TYPE,
        _context: defaultValue
      };
      return defaultValue;
    };
    exports.createElement = function(type, config, children) {
      var propName, props = {}, key = null;
      if (null != config)
        for (propName in void 0 !== config.key && (key = "" + config.key), config)
          hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (props[propName] = config[propName]);
      var childrenLength = arguments.length - 2;
      if (1 === childrenLength) props.children = children;
      else if (1 < childrenLength) {
        for (var childArray = Array(childrenLength), i = 0; i < childrenLength; i++)
          childArray[i] = arguments[i + 2];
        props.children = childArray;
      }
      if (type && type.defaultProps)
        for (propName in childrenLength = type.defaultProps, childrenLength)
          void 0 === props[propName] && (props[propName] = childrenLength[propName]);
      return ReactElement(type, key, props);
    };
    exports.createRef = function() {
      return { current: null };
    };
    exports.forwardRef = function(render) {
      return { $$typeof: REACT_FORWARD_REF_TYPE, render };
    };
    exports.isValidElement = isValidElement;
    exports.lazy = function(ctor) {
      return {
        $$typeof: REACT_LAZY_TYPE,
        _payload: { _status: -1, _result: ctor },
        _init: lazyInitializer
      };
    };
    exports.memo = function(type, compare) {
      return {
        $$typeof: REACT_MEMO_TYPE,
        type,
        compare: void 0 === compare ? null : compare
      };
    };
    exports.startTransition = function(scope) {
      var prevTransition = ReactSharedInternals.T, currentTransition = {};
      ReactSharedInternals.T = currentTransition;
      try {
        var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
        null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
        "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && returnValue.then(noop, reportGlobalError);
      } catch (error) {
        reportGlobalError(error);
      } finally {
        null !== prevTransition && null !== currentTransition.types && (prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
      }
    };
    exports.unstable_useCacheRefresh = function() {
      return ReactSharedInternals.H.useCacheRefresh();
    };
    exports.use = function(usable) {
      return ReactSharedInternals.H.use(usable);
    };
    exports.useActionState = function(action, initialState, permalink) {
      return ReactSharedInternals.H.useActionState(action, initialState, permalink);
    };
    exports.useCallback = function(callback, deps) {
      return ReactSharedInternals.H.useCallback(callback, deps);
    };
    exports.useContext = function(Context) {
      return ReactSharedInternals.H.useContext(Context);
    };
    exports.useDebugValue = function() {
    };
    exports.useDeferredValue = function(value, initialValue) {
      return ReactSharedInternals.H.useDeferredValue(value, initialValue);
    };
    exports.useEffect = function(create2, deps) {
      return ReactSharedInternals.H.useEffect(create2, deps);
    };
    exports.useEffectEvent = function(callback) {
      return ReactSharedInternals.H.useEffectEvent(callback);
    };
    exports.useId = function() {
      return ReactSharedInternals.H.useId();
    };
    exports.useImperativeHandle = function(ref, create2, deps) {
      return ReactSharedInternals.H.useImperativeHandle(ref, create2, deps);
    };
    exports.useInsertionEffect = function(create2, deps) {
      return ReactSharedInternals.H.useInsertionEffect(create2, deps);
    };
    exports.useLayoutEffect = function(create2, deps) {
      return ReactSharedInternals.H.useLayoutEffect(create2, deps);
    };
    exports.useMemo = function(create2, deps) {
      return ReactSharedInternals.H.useMemo(create2, deps);
    };
    exports.useOptimistic = function(passthrough, reducer) {
      return ReactSharedInternals.H.useOptimistic(passthrough, reducer);
    };
    exports.useReducer = function(reducer, initialArg, init) {
      return ReactSharedInternals.H.useReducer(reducer, initialArg, init);
    };
    exports.useRef = function(initialValue) {
      return ReactSharedInternals.H.useRef(initialValue);
    };
    exports.useState = function(initialState) {
      return ReactSharedInternals.H.useState(initialState);
    };
    exports.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
      return ReactSharedInternals.H.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot
      );
    };
    exports.useTransition = function() {
      return ReactSharedInternals.H.useTransition();
    };
    exports.version = "19.2.8";
  }
});

// node_modules/react/cjs/react.development.js
var require_react_development = __commonJS({
  "node_modules/react/cjs/react.development.js"(exports, module) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function defineDeprecationWarning(methodName, info) {
        Object.defineProperty(Component.prototype, methodName, {
          get: function() {
            console.warn(
              "%s(...) is deprecated in plain JavaScript React classes. %s",
              info[0],
              info[1]
            );
          }
        });
      }
      function getIteratorFn(maybeIterable) {
        if (null === maybeIterable || "object" !== typeof maybeIterable)
          return null;
        maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
        return "function" === typeof maybeIterable ? maybeIterable : null;
      }
      function warnNoop(publicInstance, callerName) {
        publicInstance = (publicInstance = publicInstance.constructor) && (publicInstance.displayName || publicInstance.name) || "ReactClass";
        var warningKey = publicInstance + "." + callerName;
        didWarnStateUpdateForUnmountedComponent[warningKey] || (console.error(
          "Can't call %s on a component that is not yet mounted. This is a no-op, but it might indicate a bug in your application. Instead, assign to `this.state` directly or define a `state = {};` class property with the desired state in the %s component.",
          callerName,
          publicInstance
        ), didWarnStateUpdateForUnmountedComponent[warningKey] = true);
      }
      function Component(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function ComponentDummy() {
      }
      function PureComponent(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function noop() {
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function cloneAndReplaceKey(oldElement, newKey) {
        newKey = ReactElement(
          oldElement.type,
          newKey,
          oldElement.props,
          oldElement._owner,
          oldElement._debugStack,
          oldElement._debugTask
        );
        oldElement._store && (newKey._store.validated = oldElement._store.validated);
        return newKey;
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      function escape(key) {
        var escaperLookup = { "=": "=0", ":": "=2" };
        return "$" + key.replace(/[=:]/g, function(match) {
          return escaperLookup[match];
        });
      }
      function getElementKey(element, index) {
        return "object" === typeof element && null !== element && null != element.key ? (checkKeyStringCoercion(element.key), escape("" + element.key)) : index.toString(36);
      }
      function resolveThenable(thenable) {
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
          default:
            switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
              function(fulfilledValue) {
                "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
              },
              function(error) {
                "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            )), thenable.status) {
              case "fulfilled":
                return thenable.value;
              case "rejected":
                throw thenable.reason;
            }
        }
        throw thenable;
      }
      function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
        var type = typeof children;
        if ("undefined" === type || "boolean" === type) children = null;
        var invokeCallback = false;
        if (null === children) invokeCallback = true;
        else
          switch (type) {
            case "bigint":
            case "string":
            case "number":
              invokeCallback = true;
              break;
            case "object":
              switch (children.$$typeof) {
                case REACT_ELEMENT_TYPE:
                case REACT_PORTAL_TYPE:
                  invokeCallback = true;
                  break;
                case REACT_LAZY_TYPE:
                  return invokeCallback = children._init, mapIntoArray(
                    invokeCallback(children._payload),
                    array,
                    escapedPrefix,
                    nameSoFar,
                    callback
                  );
              }
          }
        if (invokeCallback) {
          invokeCallback = children;
          callback = callback(invokeCallback);
          var childKey = "" === nameSoFar ? "." + getElementKey(invokeCallback, 0) : nameSoFar;
          isArrayImpl(callback) ? (escapedPrefix = "", null != childKey && (escapedPrefix = childKey.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
            return c;
          })) : null != callback && (isValidElement(callback) && (null != callback.key && (invokeCallback && invokeCallback.key === callback.key || checkKeyStringCoercion(callback.key)), escapedPrefix = cloneAndReplaceKey(
            callback,
            escapedPrefix + (null == callback.key || invokeCallback && invokeCallback.key === callback.key ? "" : ("" + callback.key).replace(
              userProvidedKeyEscapeRegex,
              "$&/"
            ) + "/") + childKey
          ), "" !== nameSoFar && null != invokeCallback && isValidElement(invokeCallback) && null == invokeCallback.key && invokeCallback._store && !invokeCallback._store.validated && (escapedPrefix._store.validated = 2), callback = escapedPrefix), array.push(callback));
          return 1;
        }
        invokeCallback = 0;
        childKey = "" === nameSoFar ? "." : nameSoFar + ":";
        if (isArrayImpl(children))
          for (var i = 0; i < children.length; i++)
            nameSoFar = children[i], type = childKey + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if (i = getIteratorFn(children), "function" === typeof i)
          for (i === children.entries && (didWarnAboutMaps || console.warn(
            "Using Maps as children is not supported. Use an array of keyed ReactElements instead."
          ), didWarnAboutMaps = true), children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
            nameSoFar = nameSoFar.value, type = childKey + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if ("object" === type) {
          if ("function" === typeof children.then)
            return mapIntoArray(
              resolveThenable(children),
              array,
              escapedPrefix,
              nameSoFar,
              callback
            );
          array = String(children);
          throw Error(
            "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
          );
        }
        return invokeCallback;
      }
      function mapChildren(children, func, context) {
        if (null == children) return children;
        var result = [], count = 0;
        mapIntoArray(children, result, "", "", function(child) {
          return func.call(context, child, count++);
        });
        return result;
      }
      function lazyInitializer(payload) {
        if (-1 === payload._status) {
          var ioInfo = payload._ioInfo;
          null != ioInfo && (ioInfo.start = ioInfo.end = performance.now());
          ioInfo = payload._result;
          var thenable = ioInfo();
          thenable.then(
            function(moduleObject) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 1;
                payload._result = moduleObject;
                var _ioInfo = payload._ioInfo;
                null != _ioInfo && (_ioInfo.end = performance.now());
                void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
              }
            },
            function(error) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 2;
                payload._result = error;
                var _ioInfo2 = payload._ioInfo;
                null != _ioInfo2 && (_ioInfo2.end = performance.now());
                void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            }
          );
          ioInfo = payload._ioInfo;
          if (null != ioInfo) {
            ioInfo.value = thenable;
            var displayName = thenable.displayName;
            "string" === typeof displayName && (ioInfo.name = displayName);
          }
          -1 === payload._status && (payload._status = 0, payload._result = thenable);
        }
        if (1 === payload._status)
          return ioInfo = payload._result, void 0 === ioInfo && console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))\n\nDid you accidentally put curly braces around the import?",
            ioInfo
          ), "default" in ioInfo || console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))",
            ioInfo
          ), ioInfo.default;
        throw payload._result;
      }
      function resolveDispatcher() {
        var dispatcher = ReactSharedInternals.H;
        null === dispatcher && console.error(
          "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem."
        );
        return dispatcher;
      }
      function releaseAsyncTransition() {
        ReactSharedInternals.asyncTransitions--;
      }
      function enqueueTask(task) {
        if (null === enqueueTaskImpl)
          try {
            var requireString = ("require" + Math.random()).slice(0, 7);
            enqueueTaskImpl = (module && module[requireString]).call(
              module,
              "timers"
            ).setImmediate;
          } catch (_err) {
            enqueueTaskImpl = function(callback) {
              false === didWarnAboutMessageChannel && (didWarnAboutMessageChannel = true, "undefined" === typeof MessageChannel && console.error(
                "This browser does not have a MessageChannel implementation, so enqueuing tasks via await act(async () => ...) will fail. Please file an issue at https://github.com/facebook/react/issues if you encounter this warning."
              ));
              var channel = new MessageChannel();
              channel.port1.onmessage = callback;
              channel.port2.postMessage(void 0);
            };
          }
        return enqueueTaskImpl(task);
      }
      function aggregateErrors(errors) {
        return 1 < errors.length && "function" === typeof AggregateError ? new AggregateError(errors) : errors[0];
      }
      function popActScope(prevActQueue, prevActScopeDepth) {
        prevActScopeDepth !== actScopeDepth - 1 && console.error(
          "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
        );
        actScopeDepth = prevActScopeDepth;
      }
      function recursivelyFlushAsyncActWork(returnValue, resolve, reject) {
        var queue = ReactSharedInternals.actQueue;
        if (null !== queue)
          if (0 !== queue.length)
            try {
              flushActQueue(queue);
              enqueueTask(function() {
                return recursivelyFlushAsyncActWork(returnValue, resolve, reject);
              });
              return;
            } catch (error) {
              ReactSharedInternals.thrownErrors.push(error);
            }
          else ReactSharedInternals.actQueue = null;
        0 < ReactSharedInternals.thrownErrors.length ? (queue = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, reject(queue)) : resolve(returnValue);
      }
      function flushActQueue(queue) {
        if (!isFlushing) {
          isFlushing = true;
          var i = 0;
          try {
            for (; i < queue.length; i++) {
              var callback = queue[i];
              do {
                ReactSharedInternals.didUsePromise = false;
                var continuation = callback(false);
                if (null !== continuation) {
                  if (ReactSharedInternals.didUsePromise) {
                    queue[i] = callback;
                    queue.splice(0, i);
                    return;
                  }
                  callback = continuation;
                } else break;
              } while (1);
            }
            queue.length = 0;
          } catch (error) {
            queue.splice(0, i + 1), ReactSharedInternals.thrownErrors.push(error);
          } finally {
            isFlushing = false;
          }
        }
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = /* @__PURE__ */ Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo"), REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity"), MAYBE_ITERATOR_SYMBOL = Symbol.iterator, didWarnStateUpdateForUnmountedComponent = {}, ReactNoopUpdateQueue = {
        isMounted: function() {
          return false;
        },
        enqueueForceUpdate: function(publicInstance) {
          warnNoop(publicInstance, "forceUpdate");
        },
        enqueueReplaceState: function(publicInstance) {
          warnNoop(publicInstance, "replaceState");
        },
        enqueueSetState: function(publicInstance) {
          warnNoop(publicInstance, "setState");
        }
      }, assign = Object.assign, emptyObject = {};
      Object.freeze(emptyObject);
      Component.prototype.isReactComponent = {};
      Component.prototype.setState = function(partialState, callback) {
        if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
          throw Error(
            "takes an object of state variables to update or a function which returns an object of state variables."
          );
        this.updater.enqueueSetState(this, partialState, callback, "setState");
      };
      Component.prototype.forceUpdate = function(callback) {
        this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
      };
      var deprecatedAPIs = {
        isMounted: [
          "isMounted",
          "Instead, make sure to clean up subscriptions and pending requests in componentWillUnmount to prevent memory leaks."
        ],
        replaceState: [
          "replaceState",
          "Refactor your code to use setState instead (see https://github.com/facebook/react/issues/3236)."
        ]
      };
      for (fnName in deprecatedAPIs)
        deprecatedAPIs.hasOwnProperty(fnName) && defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
      ComponentDummy.prototype = Component.prototype;
      deprecatedAPIs = PureComponent.prototype = new ComponentDummy();
      deprecatedAPIs.constructor = PureComponent;
      assign(deprecatedAPIs, Component.prototype);
      deprecatedAPIs.isPureReactComponent = true;
      var isArrayImpl = Array.isArray, REACT_CLIENT_REFERENCE = /* @__PURE__ */ Symbol.for("react.client.reference"), ReactSharedInternals = {
        H: null,
        A: null,
        T: null,
        S: null,
        actQueue: null,
        asyncTransitions: 0,
        isBatchingLegacy: false,
        didScheduleLegacyUpdate: false,
        didUsePromise: false,
        thrownErrors: [],
        getCurrentStack: null,
        recentlyCreatedOwnerStacks: 0
      }, hasOwnProperty = Object.prototype.hasOwnProperty, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      deprecatedAPIs = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown, didWarnAboutOldJSXRuntime;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = deprecatedAPIs.react_stack_bottom_frame.bind(
        deprecatedAPIs,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutMaps = false, userProvidedKeyEscapeRegex = /\/+/g, reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
        if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
          var event = new window.ErrorEvent("error", {
            bubbles: true,
            cancelable: true,
            message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
            error
          });
          if (!window.dispatchEvent(event)) return;
        } else if ("object" === typeof process && "function" === typeof process.emit) {
          process.emit("uncaughtException", error);
          return;
        }
        console.error(error);
      }, didWarnAboutMessageChannel = false, enqueueTaskImpl = null, actScopeDepth = 0, didWarnNoAwaitAct = false, isFlushing = false, queueSeveralMicrotasks = "function" === typeof queueMicrotask ? function(callback) {
        queueMicrotask(function() {
          return queueMicrotask(callback);
        });
      } : enqueueTask;
      deprecatedAPIs = Object.freeze({
        __proto__: null,
        c: function(size) {
          return resolveDispatcher().useMemoCache(size);
        }
      });
      var fnName = {
        map: mapChildren,
        forEach: function(children, forEachFunc, forEachContext) {
          mapChildren(
            children,
            function() {
              forEachFunc.apply(this, arguments);
            },
            forEachContext
          );
        },
        count: function(children) {
          var n = 0;
          mapChildren(children, function() {
            n++;
          });
          return n;
        },
        toArray: function(children) {
          return mapChildren(children, function(child) {
            return child;
          }) || [];
        },
        only: function(children) {
          if (!isValidElement(children))
            throw Error(
              "React.Children.only expected to receive a single React element child."
            );
          return children;
        }
      };
      exports.Activity = REACT_ACTIVITY_TYPE;
      exports.Children = fnName;
      exports.Component = Component;
      exports.Fragment = REACT_FRAGMENT_TYPE;
      exports.Profiler = REACT_PROFILER_TYPE;
      exports.PureComponent = PureComponent;
      exports.StrictMode = REACT_STRICT_MODE_TYPE;
      exports.Suspense = REACT_SUSPENSE_TYPE;
      exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
      exports.__COMPILER_RUNTIME = deprecatedAPIs;
      exports.act = function(callback) {
        var prevActQueue = ReactSharedInternals.actQueue, prevActScopeDepth = actScopeDepth;
        actScopeDepth++;
        var queue = ReactSharedInternals.actQueue = null !== prevActQueue ? prevActQueue : [], didAwaitActCall = false;
        try {
          var result = callback();
        } catch (error) {
          ReactSharedInternals.thrownErrors.push(error);
        }
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw popActScope(prevActQueue, prevActScopeDepth), callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        if (null !== result && "object" === typeof result && "function" === typeof result.then) {
          var thenable = result;
          queueSeveralMicrotasks(function() {
            didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
              "You called act(async () => ...) without await. This could lead to unexpected testing behaviour, interleaving multiple act calls and mixing their scopes. You should - await act(async () => ...);"
            ));
          });
          return {
            then: function(resolve, reject) {
              didAwaitActCall = true;
              thenable.then(
                function(returnValue) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  if (0 === prevActScopeDepth) {
                    try {
                      flushActQueue(queue), enqueueTask(function() {
                        return recursivelyFlushAsyncActWork(
                          returnValue,
                          resolve,
                          reject
                        );
                      });
                    } catch (error$0) {
                      ReactSharedInternals.thrownErrors.push(error$0);
                    }
                    if (0 < ReactSharedInternals.thrownErrors.length) {
                      var _thrownError = aggregateErrors(
                        ReactSharedInternals.thrownErrors
                      );
                      ReactSharedInternals.thrownErrors.length = 0;
                      reject(_thrownError);
                    }
                  } else resolve(returnValue);
                },
                function(error) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  0 < ReactSharedInternals.thrownErrors.length ? (error = aggregateErrors(
                    ReactSharedInternals.thrownErrors
                  ), ReactSharedInternals.thrownErrors.length = 0, reject(error)) : reject(error);
                }
              );
            }
          };
        }
        var returnValue$jscomp$0 = result;
        popActScope(prevActQueue, prevActScopeDepth);
        0 === prevActScopeDepth && (flushActQueue(queue), 0 !== queue.length && queueSeveralMicrotasks(function() {
          didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
            "A component suspended inside an `act` scope, but the `act` call was not awaited. When testing React components that depend on asynchronous data, you must await the result:\n\nawait act(() => ...)"
          ));
        }), ReactSharedInternals.actQueue = null);
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        return {
          then: function(resolve, reject) {
            didAwaitActCall = true;
            0 === prevActScopeDepth ? (ReactSharedInternals.actQueue = queue, enqueueTask(function() {
              return recursivelyFlushAsyncActWork(
                returnValue$jscomp$0,
                resolve,
                reject
              );
            })) : resolve(returnValue$jscomp$0);
          }
        };
      };
      exports.cache = function(fn) {
        return function() {
          return fn.apply(null, arguments);
        };
      };
      exports.cacheSignal = function() {
        return null;
      };
      exports.captureOwnerStack = function() {
        var getCurrentStack = ReactSharedInternals.getCurrentStack;
        return null === getCurrentStack ? null : getCurrentStack();
      };
      exports.cloneElement = function(element, config, children) {
        if (null === element || void 0 === element)
          throw Error(
            "The argument must be a React element, but you passed " + element + "."
          );
        var props = assign({}, element.props), key = element.key, owner = element._owner;
        if (null != config) {
          var JSCompiler_inline_result;
          a: {
            if (hasOwnProperty.call(config, "ref") && (JSCompiler_inline_result = Object.getOwnPropertyDescriptor(
              config,
              "ref"
            ).get) && JSCompiler_inline_result.isReactWarning) {
              JSCompiler_inline_result = false;
              break a;
            }
            JSCompiler_inline_result = void 0 !== config.ref;
          }
          JSCompiler_inline_result && (owner = getOwner());
          hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key);
          for (propName in config)
            !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
        }
        var propName = arguments.length - 2;
        if (1 === propName) props.children = children;
        else if (1 < propName) {
          JSCompiler_inline_result = Array(propName);
          for (var i = 0; i < propName; i++)
            JSCompiler_inline_result[i] = arguments[i + 2];
          props.children = JSCompiler_inline_result;
        }
        props = ReactElement(
          element.type,
          key,
          props,
          owner,
          element._debugStack,
          element._debugTask
        );
        for (key = 2; key < arguments.length; key++)
          validateChildKeys(arguments[key]);
        return props;
      };
      exports.createContext = function(defaultValue) {
        defaultValue = {
          $$typeof: REACT_CONTEXT_TYPE,
          _currentValue: defaultValue,
          _currentValue2: defaultValue,
          _threadCount: 0,
          Provider: null,
          Consumer: null
        };
        defaultValue.Provider = defaultValue;
        defaultValue.Consumer = {
          $$typeof: REACT_CONSUMER_TYPE,
          _context: defaultValue
        };
        defaultValue._currentRenderer = null;
        defaultValue._currentRenderer2 = null;
        return defaultValue;
      };
      exports.createElement = function(type, config, children) {
        for (var i = 2; i < arguments.length; i++)
          validateChildKeys(arguments[i]);
        i = {};
        var key = null;
        if (null != config)
          for (propName in didWarnAboutOldJSXRuntime || !("__self" in config) || "key" in config || (didWarnAboutOldJSXRuntime = true, console.warn(
            "Your app (or one of its dependencies) is using an outdated JSX transform. Update to the modern JSX transform for faster performance: https://react.dev/link/new-jsx-transform"
          )), hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key), config)
            hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (i[propName] = config[propName]);
        var childrenLength = arguments.length - 2;
        if (1 === childrenLength) i.children = children;
        else if (1 < childrenLength) {
          for (var childArray = Array(childrenLength), _i = 0; _i < childrenLength; _i++)
            childArray[_i] = arguments[_i + 2];
          Object.freeze && Object.freeze(childArray);
          i.children = childArray;
        }
        if (type && type.defaultProps)
          for (propName in childrenLength = type.defaultProps, childrenLength)
            void 0 === i[propName] && (i[propName] = childrenLength[propName]);
        key && defineKeyPropWarningGetter(
          i,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        var propName = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        return ReactElement(
          type,
          key,
          i,
          getOwner(),
          propName ? Error("react-stack-top-frame") : unknownOwnerDebugStack,
          propName ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports.createRef = function() {
        var refObject = { current: null };
        Object.seal(refObject);
        return refObject;
      };
      exports.forwardRef = function(render) {
        null != render && render.$$typeof === REACT_MEMO_TYPE ? console.error(
          "forwardRef requires a render function but received a `memo` component. Instead of forwardRef(memo(...)), use memo(forwardRef(...))."
        ) : "function" !== typeof render ? console.error(
          "forwardRef requires a render function but was given %s.",
          null === render ? "null" : typeof render
        ) : 0 !== render.length && 2 !== render.length && console.error(
          "forwardRef render functions accept exactly two parameters: props and ref. %s",
          1 === render.length ? "Did you forget to use the ref parameter?" : "Any additional parameter will be undefined."
        );
        null != render && null != render.defaultProps && console.error(
          "forwardRef render functions do not support defaultProps. Did you accidentally pass a React component?"
        );
        var elementType = { $$typeof: REACT_FORWARD_REF_TYPE, render }, ownName;
        Object.defineProperty(elementType, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            render.name || render.displayName || (Object.defineProperty(render, "name", { value: name }), render.displayName = name);
          }
        });
        return elementType;
      };
      exports.isValidElement = isValidElement;
      exports.lazy = function(ctor) {
        ctor = { _status: -1, _result: ctor };
        var lazyType = {
          $$typeof: REACT_LAZY_TYPE,
          _payload: ctor,
          _init: lazyInitializer
        }, ioInfo = {
          name: "lazy",
          start: -1,
          end: -1,
          value: null,
          owner: null,
          debugStack: Error("react-stack-top-frame"),
          debugTask: console.createTask ? console.createTask("lazy()") : null
        };
        ctor._ioInfo = ioInfo;
        lazyType._debugInfo = [{ awaited: ioInfo }];
        return lazyType;
      };
      exports.memo = function(type, compare) {
        null == type && console.error(
          "memo: The first argument must be a component. Instead received: %s",
          null === type ? "null" : typeof type
        );
        compare = {
          $$typeof: REACT_MEMO_TYPE,
          type,
          compare: void 0 === compare ? null : compare
        };
        var ownName;
        Object.defineProperty(compare, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            type.name || type.displayName || (Object.defineProperty(type, "name", { value: name }), type.displayName = name);
          }
        });
        return compare;
      };
      exports.startTransition = function(scope) {
        var prevTransition = ReactSharedInternals.T, currentTransition = {};
        currentTransition._updatedFibers = /* @__PURE__ */ new Set();
        ReactSharedInternals.T = currentTransition;
        try {
          var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
          null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
          "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && (ReactSharedInternals.asyncTransitions++, returnValue.then(releaseAsyncTransition, releaseAsyncTransition), returnValue.then(noop, reportGlobalError));
        } catch (error) {
          reportGlobalError(error);
        } finally {
          null === prevTransition && currentTransition._updatedFibers && (scope = currentTransition._updatedFibers.size, currentTransition._updatedFibers.clear(), 10 < scope && console.warn(
            "Detected a large number of updates inside startTransition. If this is due to a subscription please re-write it to use React provided hooks. Otherwise concurrent mode guarantees are off the table."
          )), null !== prevTransition && null !== currentTransition.types && (null !== prevTransition.types && prevTransition.types !== currentTransition.types && console.error(
            "We expected inner Transitions to have transferred the outer types set and that you cannot add to the outer Transition while inside the inner.This is a bug in React."
          ), prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
        }
      };
      exports.unstable_useCacheRefresh = function() {
        return resolveDispatcher().useCacheRefresh();
      };
      exports.use = function(usable) {
        return resolveDispatcher().use(usable);
      };
      exports.useActionState = function(action, initialState, permalink) {
        return resolveDispatcher().useActionState(
          action,
          initialState,
          permalink
        );
      };
      exports.useCallback = function(callback, deps) {
        return resolveDispatcher().useCallback(callback, deps);
      };
      exports.useContext = function(Context) {
        var dispatcher = resolveDispatcher();
        Context.$$typeof === REACT_CONSUMER_TYPE && console.error(
          "Calling useContext(Context.Consumer) is not supported and will cause bugs. Did you mean to call useContext(Context) instead?"
        );
        return dispatcher.useContext(Context);
      };
      exports.useDebugValue = function(value, formatterFn) {
        return resolveDispatcher().useDebugValue(value, formatterFn);
      };
      exports.useDeferredValue = function(value, initialValue) {
        return resolveDispatcher().useDeferredValue(value, initialValue);
      };
      exports.useEffect = function(create2, deps) {
        null == create2 && console.warn(
          "React Hook useEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useEffect(create2, deps);
      };
      exports.useEffectEvent = function(callback) {
        return resolveDispatcher().useEffectEvent(callback);
      };
      exports.useId = function() {
        return resolveDispatcher().useId();
      };
      exports.useImperativeHandle = function(ref, create2, deps) {
        return resolveDispatcher().useImperativeHandle(ref, create2, deps);
      };
      exports.useInsertionEffect = function(create2, deps) {
        null == create2 && console.warn(
          "React Hook useInsertionEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useInsertionEffect(create2, deps);
      };
      exports.useLayoutEffect = function(create2, deps) {
        null == create2 && console.warn(
          "React Hook useLayoutEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useLayoutEffect(create2, deps);
      };
      exports.useMemo = function(create2, deps) {
        return resolveDispatcher().useMemo(create2, deps);
      };
      exports.useOptimistic = function(passthrough, reducer) {
        return resolveDispatcher().useOptimistic(passthrough, reducer);
      };
      exports.useReducer = function(reducer, initialArg, init) {
        return resolveDispatcher().useReducer(reducer, initialArg, init);
      };
      exports.useRef = function(initialValue) {
        return resolveDispatcher().useRef(initialValue);
      };
      exports.useState = function(initialState) {
        return resolveDispatcher().useState(initialState);
      };
      exports.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
        return resolveDispatcher().useSyncExternalStore(
          subscribe,
          getSnapshot,
          getServerSnapshot
        );
      };
      exports.useTransition = function() {
        return resolveDispatcher().useTransition();
      };
      exports.version = "19.2.8";
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// node_modules/react/index.js
var require_react = __commonJS({
  "node_modules/react/index.js"(exports, module) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module.exports = require_react_production();
    } else {
      module.exports = require_react_development();
    }
  }
});

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js
var require_use_sync_external_store_shim_production = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js"(exports) {
    "use strict";
    var React = require_react();
    function is(x, y) {
      return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
    }
    var objectIs = "function" === typeof Object.is ? Object.is : is;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useLayoutEffect = React.useLayoutEffect;
    var useDebugValue2 = React.useDebugValue;
    function useSyncExternalStore$2(subscribe, getSnapshot) {
      var value = getSnapshot(), _useState = useState({ inst: { value, getSnapshot } }), inst = _useState[0].inst, forceUpdate = _useState[1];
      useLayoutEffect(
        function() {
          inst.value = value;
          inst.getSnapshot = getSnapshot;
          checkIfSnapshotChanged(inst) && forceUpdate({ inst });
        },
        [subscribe, value, getSnapshot]
      );
      useEffect(
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
    exports.useSyncExternalStore = void 0 !== React.useSyncExternalStore ? React.useSyncExternalStore : shim;
  }
});

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.development.js
var require_use_sync_external_store_shim_development = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.development.js"(exports) {
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
        cachedValue = useState({
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
        useEffect(
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
      var React = require_react(), objectIs = "function" === typeof Object.is ? Object.is : is, useState = React.useState, useEffect = React.useEffect, useLayoutEffect = React.useLayoutEffect, useDebugValue2 = React.useDebugValue, didWarnOld18Alpha = false, didWarnUncachedGetSnapshot = false, shim = "undefined" === typeof window || "undefined" === typeof window.document || "undefined" === typeof window.document.createElement ? useSyncExternalStore$1 : useSyncExternalStore$2;
      exports.useSyncExternalStore = void 0 !== React.useSyncExternalStore ? React.useSyncExternalStore : shim;
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// node_modules/use-sync-external-store/shim/index.js
var require_shim = __commonJS({
  "node_modules/use-sync-external-store/shim/index.js"(exports, module) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module.exports = require_use_sync_external_store_shim_production();
    } else {
      module.exports = require_use_sync_external_store_shim_development();
    }
  }
});

// node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js
var require_with_selector_production = __commonJS({
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js"(exports) {
    "use strict";
    var React = require_react();
    var shim = require_shim();
    function is(x, y) {
      return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
    }
    var objectIs = "function" === typeof Object.is ? Object.is : is;
    var useSyncExternalStore = shim.useSyncExternalStore;
    var useRef = React.useRef;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useDebugValue2 = React.useDebugValue;
    exports.useSyncExternalStoreWithSelector = function(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
      var instRef = useRef(null);
      if (null === instRef.current) {
        var inst = { hasValue: false, value: null };
        instRef.current = inst;
      } else inst = instRef.current;
      instRef = useMemo(
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
      useEffect(
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
  "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.development.js"(exports) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function is(x, y) {
        return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var React = require_react(), shim = require_shim(), objectIs = "function" === typeof Object.is ? Object.is : is, useSyncExternalStore = shim.useSyncExternalStore, useRef = React.useRef, useEffect = React.useEffect, useMemo = React.useMemo, useDebugValue2 = React.useDebugValue;
      exports.useSyncExternalStoreWithSelector = function(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
        var instRef = useRef(null);
        if (null === instRef.current) {
          var inst = { hasValue: false, value: null };
          instRef.current = inst;
        } else inst = instRef.current;
        instRef = useMemo(
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
        useEffect(
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
  "node_modules/use-sync-external-store/shim/with-selector.js"(exports, module) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module.exports = require_with_selector_production();
    } else {
      module.exports = require_with_selector_development();
    }
  }
});

// node_modules/zustand/esm/index.mjs
function useStore(api2, selector = identity, equalityFn) {
  if ((import.meta.env ? import.meta.env.MODE : void 0) !== "production" && equalityFn && !didWarnAboutEqualityFn) {
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
var import_react, import_with_selector, useDebugValue, useSyncExternalStoreWithSelector, didWarnAboutEqualityFn, identity, createImpl, create;
var init_esm = __esm({
  "node_modules/zustand/esm/index.mjs"() {
    init_vanilla();
    init_vanilla();
    import_react = __toESM(require_react(), 1);
    import_with_selector = __toESM(require_with_selector(), 1);
    ({ useDebugValue } = import_react.default);
    ({ useSyncExternalStoreWithSelector } = import_with_selector.default);
    didWarnAboutEqualityFn = false;
    identity = (arg) => arg;
    createImpl = (createState) => {
      if ((import.meta.env ? import.meta.env.MODE : void 0) !== "production" && typeof createState !== "function") {
        console.warn(
          "[DEPRECATED] Passing a vanilla store will be unsupported in a future version. Instead use `import { useStore } from 'zustand'`."
        );
      }
      const api2 = typeof createState === "function" ? createStore(createState) : createState;
      const useBoundStore = (selector, equalityFn) => useStore(api2, selector, equalityFn);
      Object.assign(useBoundStore, api2);
      return useBoundStore;
    };
    create = (createState) => createState ? createImpl(createState) : createImpl;
  }
});

// src/lib/fs.ts
var api;
var init_fs = __esm({
  "src/lib/fs.ts"() {
    "use strict";
    api = {
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
      coderList: (rel) => window.coder.coderList(rel),
      coderRead: (rel) => window.coder.coderRead(rel),
      coderWrite: (rel, content) => window.coder.coderWrite(rel, content),
      coderDelete: (rel) => window.coder.coderDelete(rel),
      searchContent: (root, query) => window.coder.searchContent(root, query),
      readImage: (absPath) => window.coder.readImage(absPath),
      normalizeImage: (absPath) => window.coder.normalizeImage(absPath),
      captureScreen: () => window.coder.captureScreen(),
      captureRegion: () => window.coder.captureRegion(),
      getPathForFile: (file) => window.coder.getPathForFile(file),
      storeGet: (key) => window.coder.storeGet(key),
      storeSet: (key, value) => window.coder.storeSet(key, value),
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
            return { ok: false, error: "External open is unavailable (preload outdated \u2014 rebuild the app)." };
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
            return { ok: false, error: "Reveal in file manager is unavailable (preload outdated \u2014 rebuild the app)." };
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
            return { ok: false, error: "Terminal open is unavailable (preload outdated \u2014 rebuild the app)." };
          }
          const res = await fn.call(window.coder, dir);
          if (res && typeof res.ok === "boolean") return res;
          return { ok: false, error: "Terminal open is unavailable in this environment." };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    };
  }
});

// src/lib/bidi.ts
var PERSIAN_RANGE, RTL_CHAR_RE, FA_DIGITS, DIGITS_RE, LINE_RANGE_RE, LINE_RANGE_CONN_RE, PATH_RE, BARE_RANGE_FENCE_RE, MIXED_WORD_RE, SCRIPT_BOUNDARY_RE;
var init_bidi = __esm({
  "src/lib/bidi.ts"() {
    "use strict";
    PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
    RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
    FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
    DIGITS_RE = `[0-9${FA_DIGITS}]`;
    LINE_RANGE_RE = new RegExp(
      `\u062E\u0637\\s*(${DIGITS_RE}+)(?:\\s*[-\u2013\u2014~]\\s*(${DIGITS_RE}+))?`
    );
    LINE_RANGE_CONN_RE = new RegExp(
      `\u062E\u0637\\s*(${DIGITS_RE}+)\\s+(?:\u062A\u0627|\u0627\u0644\u06CC)\\s+(${DIGITS_RE}+)`
    );
    PATH_RE = new RegExp(
      `((?:[\\w\\/\\\\-]+\\.)*[\\w\\/\\\\-]+\\.\\w+)(?=:?(?:${DIGITS_RE}+|$))(?::(${DIGITS_RE}+)(?:-(${DIGITS_RE}+))?)?`
    );
    BARE_RANGE_FENCE_RE = new RegExp(
      "^```\\s*([\\w-]+):(" + DIGITS_RE + "+)-(" + DIGITS_RE + "+)\\s*$"
    );
    MIXED_WORD_RE = new RegExp(
      `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
      "g"
    );
    SCRIPT_BOUNDARY_RE = new RegExp(
      `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
      "g"
    );
  }
});

// src/lib/context.ts
var PERSIAN_CHAR;
var init_context = __esm({
  "src/lib/context.ts"() {
    "use strict";
    init_bidi();
    PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
  }
});

// src/lib/api.ts
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
    const url = await api.getSidecarUrl();
    if (url) sidecarUrl = url;
    return sidecarUrl;
  })();
  sidecarInFlight = p;
  p.finally(() => {
    sidecarInFlight = null;
  });
  return p;
}
function providerKeys(cfg) {
  const raw = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : [];
  const out = raw.filter((k) => typeof k === "string" && k.trim() !== "");
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim() !== "" && !out.includes(cfg.apiKey.trim())) out.push(cfg.apiKey.trim());
  return out;
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
        providers: params.providers ?? {},
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
    const res = await fetch(`${url}/mcp`);
    if (!res.ok) return { mcpServers: {}, builtins: [] };
    const data = await res.json();
    return {
      mcpServers: data.mcpServers ?? {},
      builtins: Array.isArray(data.builtins) ? data.builtins : []
    };
  } catch {
    return { mcpServers: {}, builtins: [] };
  }
}
async function saveMcp(name, cfg) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/mcp`, {
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
    await fetch(`${url}/mcp/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
  } catch {
  }
}
var sidecarUrl, sidecarInFlight;
var init_api = __esm({
  "src/lib/api.ts"() {
    "use strict";
    init_fs();
    init_context();
    sidecarUrl = null;
    sidecarInFlight = null;
    api.onSidecarChanged(() => {
      sidecarUrl = null;
      sidecarInFlight = null;
    });
    api.onSidecarDead(() => {
      sidecarUrl = null;
      sidecarInFlight = null;
    });
  }
});

// src/lib/modes.ts
function normalizeMode(id) {
  if (id === "chat") return "ask";
  if (id === "codewriter") return "build";
  return id || "ask";
}
var BUILTIN_MODES, BUILTIN_IDS, FALLBACK_MODE;
var init_modes = __esm({
  "src/lib/modes.ts"() {
    "use strict";
    BUILTIN_MODES = [
      {
        id: "ask",
        label: "Ask",
        icon: "chat",
        description: "Mentor mode: answers your questions and teaches you step by step \u2014 which file, which line, what to change. Read-only, never modifies anything.",
        capabilities: { readFiles: true, writeFiles: false, runTerminal: false, web: true }
      },
      {
        id: "plan",
        label: "Plan",
        icon: "list",
        description: "Plans the work: scouts the code and lays out concrete steps and changes for Build mode. Read-only files and terminal, never writes.",
        capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
      },
      {
        id: "build",
        label: "Build",
        icon: "code",
        description: "Write and edit code, run commands. Full access to your project.",
        capabilities: { readFiles: true, writeFiles: true, runTerminal: true, web: true }
      }
    ];
    BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id));
    FALLBACK_MODE = BUILTIN_MODES[0];
  }
});

// src/lib/secrets.ts
function getKey() {
  if (!keyPromise) {
    const p = (async () => {
      try {
        const b64 = await window.coder.secretsGetKey();
        if (!b64) return null;
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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
function toB64(u8) {
  let s2 = "";
  for (const b of u8) s2 += String.fromCharCode(b);
  return btoa(s2);
}
function fromB64(s2) {
  const bin = atob(s2);
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
var PREFIX, keyPromise, enc, dec;
var init_secrets = __esm({
  "src/lib/secrets.ts"() {
    "use strict";
    PREFIX = "enc:v1:";
    keyPromise = null;
    enc = new TextEncoder();
    dec = new TextDecoder();
  }
});

// src/lib/provider-meta.ts
var PROVIDER_META, FOREIGN_PROVIDER_PREFIXES;
var init_provider_meta = __esm({
  "src/lib/provider-meta.ts"() {
    "use strict";
    PROVIDER_META = {
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
        baseUrlHint: "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1",
        baseUrlDesc: "Workers AI.",
        extraHint: "Also requires CLOUDFLARE_ACCOUNT_ID in your environment.",
        defaultBaseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1"
      },
      tokenrouter: {
        kind: "tokenrouter",
        label: "TokenRouter",
        name: "TokenRouter",
        requiresKey: true,
        builtin: true,
        baseUrlHint: "https://api.tokenrouter.com/v1",
        baseUrlDesc: "Unified AI model hub.",
        defaultBaseUrl: "https://api.tokenrouter.com/v1"
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
    FOREIGN_PROVIDER_PREFIXES = /* @__PURE__ */ new Set([
      ...Object.keys(PROVIDER_META),
      "opencode"
    ]);
  }
});

// src/lib/themes.ts
var DEFAULT_THEME;
var init_themes = __esm({
  "src/lib/themes.ts"() {
    "use strict";
    DEFAULT_THEME = "catppuccin";
  }
});

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
var init_usage = __esm({
  "src/lib/usage.ts"() {
    "use strict";
  }
});

// src/lib/chatTree.ts
function nid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clampSize(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}
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
  for (const c of node.children) out.push(...collectChatIds(c));
  return out;
}
function leafCount(node) {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.children.reduce((n, c) => n + leafCount(c), 0);
}
function containsChat(node, chatId) {
  if (!node) return false;
  if (node.kind === "leaf") return node.chatId === chatId;
  return node.children.some((c) => containsChat(c, chatId));
}
function findLeafByChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? node : null;
  for (const c of node.children) {
    const hit = findLeafByChat(c, chatId);
    if (hit) return hit;
  }
  return null;
}
function findParent(node, childId) {
  if (!node || node.kind !== "split") return null;
  for (const c of node.children) {
    if (c.id === childId) return node;
    if (c.kind === "split") {
      const hit = findParent(c, childId);
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
  for (const c of node.children) {
    const next = removeChat(c, chatId);
    if (next) children.push(next);
    if (next !== c) changed = true;
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
  const children = node.children.map((c) => {
    const next = swapChats(c, a, b) ?? c;
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function replaceChat(node, targetChatId, nextChatId) {
  if (node.kind === "leaf") {
    return node.chatId === targetChatId ? { ...node, chatId: nextChatId } : node;
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = replaceChat(c, targetChatId, nextChatId);
    if (next !== c) changed = true;
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
  for (const c of node.children) {
    const next = normalizeTree(c, validIds, seen);
    if (next) children.push(next);
    if (next !== c) changed = true;
  }
  if (children.length === 0) return null;
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
    const idx = parent.children.findIndex((c) => c.id === target.id);
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
  const before2 = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const targetLeaf = findLeafByChat(root, targetChatId);
  if (dragLeaf && targetLeaf) {
    const pDrag = findParent(root, dragLeaf.id);
    const pTarget = findParent(root, targetLeaf.id);
    if (pDrag && pTarget && pDrag.id === pTarget.id && pDrag.dir === dirNeeded) {
      const rest = pTarget.children.filter((c) => c.id !== dragLeaf.id);
      let dest = rest.findIndex((c) => c.id === targetLeaf.id) + (before2 ? 0 : 1);
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
    const idx = parent.children.findIndex((c) => c.id === target.id);
    const children = parent.children.slice();
    children.splice(before2 ? idx : idx + 1, 0, fresh);
    return replaceNode(base, parent.id, { ...parent, children });
  }
  const split = makeSplit(
    dirNeeded,
    before2 ? [fresh, { ...target }] : [{ ...target }, fresh],
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
  const before2 = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const dragSize = dragLeaf?.size ?? 1;
  if (dragLeaf) {
    if (leafCount(root) <= 1) return root;
    const base = removeChat(root, dragChatId);
    if (!base) return makeLeaf(dragChatId, dragSize);
    const fresh2 = makeLeaf(dragChatId, dragSize);
    if (base.kind === "split" && base.dir === dirNeeded) {
      const children = before2 ? [fresh2, ...base.children] : [...base.children, fresh2];
      return { ...base, children };
    }
    return makeSplit(dirNeeded, before2 ? [fresh2, base] : [base, fresh2]);
  }
  if (leafCount(root) >= CHAT_WINDOW_MAX) return root;
  const fresh = makeLeaf(dragChatId);
  if (root.kind === "split" && root.dir === dirNeeded) {
    const children = before2 ? [fresh, ...root.children] : [...root.children, fresh];
    return { ...root, children };
  }
  return makeSplit(dirNeeded, before2 ? [fresh, root] : [root, fresh]);
}
function replaceNode(node, id, next) {
  if (node.id === id) return next;
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c) => {
    const r = replaceNode(c, id, next);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...node, children } : node;
}
function setNodeSize(node, id, size) {
  if (!node) return null;
  if (node.id === id) return { ...node, size: clampSize(size) };
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = setNodeSize(c, id, size);
    if (next && next !== c) changed = true;
    return next ?? c;
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
var TREE_KEY, CHAT_WINDOW_MAX;
var init_chatTree = __esm({
  "src/lib/chatTree.ts"() {
    "use strict";
    TREE_KEY = "coder:chatTree";
    CHAT_WINDOW_MAX = 6;
  }
});

// src/lib/store.ts
var store_exports = {};
__export(store_exports, {
  MAX_COMPACTED_PER_CHAT: () => MAX_COMPACTED_PER_CHAT,
  MAX_PINNED_RECENT_MODELS: () => MAX_PINNED_RECENT_MODELS,
  MAX_SCHEDULE_RUNS_SEEN: () => MAX_SCHEDULE_RUNS_SEEN,
  PROVIDER_NAMES: () => PROVIDER_NAMES,
  capCompactedMessages: () => capCompactedMessages,
  dedupeChats: () => dedupeChats,
  flushStateNow: () => flushStateNow,
  getActiveChat: () => getActiveChat,
  getActiveMode: () => getActiveMode,
  getActiveProvider: () => getActiveProvider,
  getChatProvider: () => getChatProvider,
  lspStatusFromEvent: () => lspStatusFromEvent,
  lspStatusLabel: () => lspStatusLabel,
  normalizeChatLayout: () => normalizeChatLayout,
  normalizeScheduleRunsSeen: () => normalizeScheduleRunsSeen,
  normalizeVisibleChats: () => normalizeVisibleChats,
  providerApiKeys: () => providerApiKeys,
  sanitizeChats: () => sanitizeChats,
  sanitizeImageDataUrl: () => sanitizeImageDataUrl,
  selectLoadedChats: () => selectLoadedChats,
  sortRecentModels: () => sortRecentModels,
  useStore: () => useStore2,
  workspaceKey: () => workspaceKey
});
function normalizeScheduleRunsSeen(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return [...new Set(out)].slice(-MAX_SCHEDULE_RUNS_SEEN);
}
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
function lspStatusLabel(status) {
  if (!status) return null;
  if (status.phase === "done" || status.phase === "error") return null;
  const lang = (status.language ?? "").trim();
  const suffix = lang ? ` ${lang}` : "";
  if (status.phase === "updating") return `\u062F\u0631 \u062D\u0627\u0644 \u0622\u067E\u062F\u06CC\u062A LSP${suffix}...`;
  return `\u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628 LSP${suffix}...`;
}
function lspStatusFromEvent(ev) {
  const stage = (ev.stage ?? "").trim().toLowerCase();
  const tool = (ev.tool ?? "").trim().toLowerCase();
  const isLsp = stage === "lsp" || tool === "lsp" || tool.startsWith("lsp_");
  if (!isLsp) return null;
  const text = `${ev.summary ?? ""} ${ev.content ?? ""} ${ev.status ?? ""}`.toLowerCase();
  const updating = text.includes("updat") || text.includes("\u0622\u067E\u062F\u06CC\u062A") || text.includes("\u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC") || text.includes("\u0628\u0631\u0648\u0632");
  const done = text.includes("done") || text.includes("complete") || ev.status === "done";
  const failed2 = text.includes("fail") || text.includes("error") || ev.status === "error";
  if (failed2) return { phase: "error", language: ev.language };
  if (done) return { phase: "done", language: ev.language };
  return { phase: updating ? "updating" : "installing", language: ev.language };
}
function sanitizeChats(chats) {
  return chats.filter((c) => (c.messages?.length ?? 0) > 0).map((c) => {
    const clean = { ...c };
    delete clean.pendingAsk;
    delete clean.pendingPermission;
    return {
      ...clean,
      messages: capCompactedMessages(c.messages.map((m) => {
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
    };
  });
}
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
      const s2 = o[k];
      if (typeof s2 === "string" && s2.length > MAX_PERSIST_IMAGE_CHARS && (s2.startsWith("data:") || s2.slice(0, 80).includes("base64"))) {
        return { ...o, [k]: s2.slice(0, MAX_PERSIST_IMAGE_CHARS) + "\u2026" };
      }
    }
  }
  return v;
}
function sanitizeImageDataUrl(value) {
  if (typeof value !== "string") return null;
  const s2 = value.trim();
  if (!s2.startsWith("data:")) return null;
  if (s2.includes("\u2026")) return null;
  const comma = s2.indexOf(",");
  if (comma < 0) return null;
  const head = s2.slice(0, comma);
  let payload = s2.slice(comma + 1).replace(/\s+/g, "");
  if (!payload) return null;
  if (!/;base64/i.test(head)) {
    return head.startsWith("data:image/") ? null : s2;
  }
  if (/[^A-Za-z0-9+/=]/.test(payload)) return null;
  if (payload.length % 4 === 1) return null;
  payload += "=".repeat((4 - payload.length % 4) % 4);
  try {
    atob(payload);
  } catch {
    return null;
  }
  return `${head},${payload}`;
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
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useStore2.getState().persist(), PERSIST_DEBOUNCE_MS);
}
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
function persistPanelsSoon() {
  clearTimeout(panelPersistTimer);
  panelPersistTimer = setTimeout(() => {
    panelPersistTimer = void 0;
    void writeSettingsNow(useStore2.getState());
  }, PERSIST_DEBOUNCE_MS);
}
function writeChatsNow(s2) {
  const streaming = s2.chats.filter((c) => c.messages.some((m) => m.streaming));
  const subset = streaming.length > 0 ? streaming : s2.chats.filter((c) => c.id === s2.activeChatId);
  if (subset.length === 0) return;
  void api.storeSet("chats", sanitizeChats(subset));
}
function writeSettingsNow(s2) {
  if (!s2.settingsHydrated) return Promise.resolve();
  const seq = ++persistSeq;
  return (async () => {
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s2;
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse });
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
function writeStateNow(s2) {
  const { settings, chats, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s2;
  const seq = ++persistSeq;
  const writes = [
    (async () => {
      if (seq !== persistSeq) return;
      await api.storeSet("chats", sanitizeChats(chats));
    })()
  ];
  if (s2.settingsHydrated) {
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse });
        if (seq !== persistSeq) return;
        await api.storeSet("settings", payload);
      })()
    );
  }
  const del = s2.deletedChatIds;
  if (del.length) writes.push(api.storeSet("deleted_chats", del));
  const delW = s2.deletedWorkspaceRoots;
  if (delW.length) writes.push(api.storeSet("deleted_workspaces", delW));
  return Promise.all(writes);
}
function stackFor(chatId) {
  let st = historyStacks.get(chatId);
  if (!st) {
    st = { undo: [], redo: [] };
    historyStacks.set(chatId, st);
  }
  return st;
}
function providerApiKeys(p) {
  const raw = Array.isArray(p.apiKeys) ? p.apiKeys : [];
  const out = raw.map((k) => typeof k === "string" ? k : "").filter((k) => k.trim() !== "");
  if (out.length === 0 && typeof p.apiKey === "string" && p.apiKey.trim() !== "") out.push(p.apiKey);
  return out;
}
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
    row("cloudflare"),
    row("tokenrouter")
  ];
}
function normalizeProvider(p) {
  const rawKind = p.kind || "";
  const kind = rawKind === "opencode" ? "custom" : p.kind || "custom";
  const meta = PROVIDER_META[kind];
  const raw = p;
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
    baseUrl: p.baseUrl || meta?.defaultBaseUrl || "",
    model: p.model || "",
    contextMap: p.contextMap,
    manualContextMap: p.manualContextMap,
    manualReasoningMap: p.manualReasoningMap,
    pricingMap: p.pricingMap,
    reasoningMap: p.reasoningMap,
    thinkingLevel: p.thinkingLevel ?? "",
    models: Array.isArray(p.models) ? p.models : [],
    removedModels: Array.isArray(p.removedModels) ? p.removedModels : [],
    addedModels: Array.isArray(p.addedModels) ? p.addedModels : []
  };
}
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
    const c = chats[i];
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
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
function makeChat(mode = "ask") {
  const now = Date.now();
  const s2 = useStore2.getState();
  const activeProvider = s2.settings.providers.find((p) => p.id === s2.settings.activeProviderId) ?? s2.settings.providers[0];
  const recent = sortRecentModels(s2.recentModels)[0];
  const recentProvider = recent ? s2.settings.providers.find((p) => p.id === recent.providerId) : void 0;
  const providerId = recentProvider?.id ?? activeProvider?.id;
  const model = recentProvider && recent ? recent.model : activeProvider?.model;
  let id = uid();
  while (s2.chats.some((c) => c.id === id)) id = uid();
  return {
    id,
    title: "New chat",
    mode,
    thinkingLevel: "medium",
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
function flushStateNow() {
  clearTimeout(persistTimer);
  return writeStateNow(useStore2.getState());
}
function getActiveChat() {
  const s2 = useStore2.getState();
  return s2.chats.find((c) => c.id === s2.activeChatId) ?? null;
}
function getActiveMode() {
  return getActiveChat()?.mode ?? "ask";
}
function getActiveProvider() {
  const s2 = useStore2.getState();
  return s2.settings.providers.find((p) => p.id === s2.settings.activeProviderId) ?? s2.settings.providers[0];
}
function getChatProvider(chatId) {
  const s2 = useStore2.getState();
  const ch = chatId ? s2.chats.find((c) => c.id === chatId) ?? null : null;
  const overrideId = ch?.providerId;
  const p = s2.settings.providers.find((x) => x.id === (overrideId ?? s2.settings.activeProviderId)) ?? s2.settings.providers[0];
  return ch?.model ? { ...p, model: ch.model } : p;
}
var MAX_SCHEDULE_RUNS_SEEN, uid, MAX_COMPACTED_PER_CHAT, MID_STREAM_MS, lastMidStreamPersist, MAX_TOOL_TEXT, MAX_TOOL_ARG, MAX_PERSIST_IMAGE_CHARS, MODE_LABELS, SEARCH_PLUGIN_LABELS, persistTimer, PERSIST_DEBOUNCE_MS, OPEN_CHATS_KEY, ACTIVE_CHAT_KEY, VISIBLE_CHATS_KEY, WINDOW_SIZES_KEY, CHAT_LAYOUT_KEY, CHAT_FULL_KEY, WINDOW_FULL_KEY, TERMINAL_PANEL_KEY, TERMINAL_FULL_KEY, panelPersistTimer, persistSeq, historyStacks, PROVIDER_NAMES, MAX_PINNED_RECENT_MODELS, useStore2;
var init_store = __esm({
  "src/lib/store.ts"() {
    "use strict";
    init_esm();
    init_fs();
    init_api();
    init_modes();
    init_secrets();
    init_provider_meta();
    init_themes();
    init_usage();
    init_chatTree();
    MAX_SCHEDULE_RUNS_SEEN = 500;
    uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    MAX_COMPACTED_PER_CHAT = 50;
    MID_STREAM_MS = 2e3;
    lastMidStreamPersist = 0;
    MAX_TOOL_TEXT = 4e3;
    MAX_TOOL_ARG = 2e3;
    MAX_PERSIST_IMAGE_CHARS = 1e5;
    MODE_LABELS = { ask: "Ask", plan: "Plan", build: "Build" };
    SEARCH_PLUGIN_LABELS = {
      duckduckgo: "DuckDuckGo",
      tavily: "Tavily"
    };
    PERSIST_DEBOUNCE_MS = 100;
    OPEN_CHATS_KEY = "coder:openChats";
    ACTIVE_CHAT_KEY = "coder:activeChat";
    VISIBLE_CHATS_KEY = "coder:visibleChats";
    WINDOW_SIZES_KEY = "coder:chatWindowSizes";
    CHAT_LAYOUT_KEY = "coder:chatLayout";
    CHAT_FULL_KEY = "coder:chatFull";
    WINDOW_FULL_KEY = "coder:windowFullscreen";
    TERMINAL_PANEL_KEY = "coder:terminalPanel";
    TERMINAL_FULL_KEY = "coder:terminalFullscreen";
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
    persistSeq = 0;
    historyStacks = /* @__PURE__ */ new Map();
    PROVIDER_NAMES = Object.fromEntries(
      Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
    );
    MAX_PINNED_RECENT_MODELS = 3;
    useStore2 = create((set, get) => ({
      loaded: false,
      settingsHydrated: false,
      settings: { providers: defaultProviders(), activeProviderId: "openrouter", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80 },
      builtinMcp: [],
      root: "",
      theme: DEFAULT_THEME,
      dir: "rtl",
      fontSize: 14,
      vectorDbPath: "",
      webSearchAutoFetch: 3,
      ragWebTtlDays: 90,
      whisperModel: "Systran/faster-whisper-medium",
      whisperBaseUrl: "",
      sttProviderId: "local",
      sttModel: "whisper-1",
      sttFallbacks: [],
      ttsProviderId: "",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFallbacks: [],
      embeddingModel: "intfloat/multilingual-e5-base",
      embeddingBaseUrl: "",
      recentModels: [],
      subagentModels: {},
      cacheTtlMinutes: 60,
      historyLimit: 0,
      searchPlugins: [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
      searchConsole: { clientId: "", clientSecret: "", refreshToken: "", siteUrl: "" },
      sidebarOpen: true,
      rightPanelOpen: false,
      terminalPanelOpen: typeof window !== "undefined" ? loadTerminalPanel() : false,
      terminalFullscreen: typeof window !== "undefined" ? loadTerminalFullscreen() : false,
      dataPath: "",
      workspaceColors: {},
      pinnedWorkspaces: [],
      pinnedChats: [],
      workspaces: [],
      chats: [],
      deletedChatIds: [],
      deletedWorkspaceRoots: [],
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
        set((s2) => ({ scheduleRunsSeen: [.../* @__PURE__ */ new Set([...s2.scheduleRunsSeen, ...ids])].slice(-MAX_SCHEDULE_RUNS_SEEN) }));
        get().persist();
      },
      isStreaming: false,
      isThinking: false,
      outsideAllowed: false,
      outsideFolders: [],
      computerUse: false,
      chatAborts: {},
      setChatAbort: (chatId, abort) => set((s2) => ({ chatAborts: { ...s2.chatAborts, [chatId]: abort } })),
      load: async () => {
        const [settings, chats] = await Promise.all([
          api.storeGet("settings"),
          api.storeGet("chats")
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
        const loadedChats = dedupedChats.map((c) => {
          const clean = { ...c };
          delete clean.compacting;
          delete clean.compactNotice;
          delete clean.compactError;
          delete clean.cmdError;
          delete clean.skillNotice;
          delete clean.stalled;
          const migrated = normalizeUsageEntry(
            clean.usage,
            c.providerId ?? settings?.activeProviderId ?? "",
            providerIds
          );
          const next = migrated ? { ...clean, usage: migrated } : clean;
          if (next.goal?.active && !next.goal.paused) {
            next.goal = { ...next.goal, stopped: true };
          }
          return next.mode ? { ...next, mode: normalizeMode(next.mode) } : next;
        });
        const prevActiveId = get().activeChatId;
        const memOpen = get().openChatIds;
        const memVisible = get().visibleChatIds ?? [];
        const fallbackActive = keptChats && prevChats.some((c) => c.id === prevActiveId) ? prevActiveId : loadedChats[loadedChats.length - 1]?.id ?? "";
        const validIds = new Set(loadedChats.map((c) => c.id));
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
        if (Array.isArray(raw.providers) && raw.providers.length > 0) {
          providers = raw.providers.map(normalizeProvider);
          const present = new Set(providers.map((p) => p.id));
          for (const def of defaultProviders()) {
            if (!present.has(def.id)) providers.push(def);
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
          compactAtPercent: typeof raw.compactAtPercent === "number" && raw.compactAtPercent >= 1 && raw.compactAtPercent <= 99 ? Math.round(raw.compactAtPercent) : 80
        };
        const fontSize = typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 24 ? raw.fontSize : 14;
        document.documentElement.style.setProperty("--chat-font-size", `${fontSize}px`);
        let workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map((w) => ({
          key: String(w?.key ?? workspaceKey(String(w?.root ?? ""))),
          root: typeof w?.root === "string" ? w.root : null,
          label: String(w?.label ?? "").trim() || workspaceLabel(String(w?.root ?? ""))
        })) : [];
        const chatRoots = [...new Set(loadedChats.map((c) => c.root ?? ""))];
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
        const mergedMcp = { ...loadedSettings.mcpServers ?? {}, ...dbMcp.mcpServers ?? {} };
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
          vectorDbPath: typeof raw.vectorDbPath === "string" ? raw.vectorDbPath : "",
          dataPath: typeof raw.dataPath === "string" && raw.dataPath.trim() ? raw.dataPath : realDataPath || "",
          whisperModel: typeof raw.whisperModel === "string" && raw.whisperModel.trim() ? raw.whisperModel : "Systran/faster-whisper-medium",
          whisperBaseUrl: typeof raw.whisperBaseUrl === "string" ? raw.whisperBaseUrl : "",
          sttProviderId: typeof raw.sttProviderId === "string" && raw.sttProviderId.trim() ? raw.sttProviderId : "local",
          sttModel: typeof raw.sttModel === "string" && raw.sttModel.trim() ? raw.sttModel : "whisper-1",
          sttFallbacks: normalizeSttFallbacks(raw.sttFallbacks),
          ttsProviderId: typeof raw.ttsProviderId === "string" ? raw.ttsProviderId.trim() : "",
          // خالی مجاز است (پروایدرهای 9router بدون مدل/ویس): فقط وقتی فیلد اصلاً
          // رشته نیست (settings قدیمی) پیش‌فرض می‌گذاریم، نه وقتی کاربر پاکش کرده.
          ttsModel: typeof raw.ttsModel === "string" ? raw.ttsModel.trim() : "tts-1",
          ttsVoice: typeof raw.ttsVoice === "string" ? raw.ttsVoice.trim() : "alloy",
          ttsFallbacks: normalizeTtsFallbacks(raw.ttsFallbacks),
          embeddingModel: typeof raw.embeddingModel === "string" && raw.embeddingModel.trim() ? raw.embeddingModel : "intfloat/multilingual-e5-base",
          embeddingBaseUrl: typeof raw.embeddingBaseUrl === "string" ? raw.embeddingBaseUrl : "",
          subagentModels: (() => {
            if (typeof raw.subagentModels !== "object" || raw.subagentModels === null) return {};
            const m = { ...raw.subagentModels };
            const legacy = (m.subagent ?? "").trim();
            if (legacy) {
              m.explore = legacy;
              delete m.subagent;
            }
            return m;
          })(),
          // Coerce numbers defensively: settings.json may round-trip numbers
          // through JSON safely, but the IPC layer or an older settings file
          // can hand us string-shaped digits ("30") or null. Accept anything that
          // coerces to a valid value rather than silently falling back to the
          // default — the user did set it, so don't erase their choice.
          cacheTtlMinutes: coercePositiveInt(raw.cacheTtlMinutes, 60),
          historyLimit: coerceNonNegInt(raw.historyLimit, 0),
          // Migration: اگه settings قدیمی webSearchTtlDays داشت ولی ragWebTtlDays نداشت،
          // مقدار webSearchTtlDays → ragWebTtlDays منتقل بشه.
          ragWebTtlDays: coercePositiveInt(raw.ragWebTtlDays, 0) || coercePositiveInt(raw.webSearchTtlDays, 0) || 90,
          // 0 is a valid, deliberate value (auto-fetch disabled) — keep it.
          webSearchAutoFetch: coerceBoundedInt(raw.webSearchAutoFetch, 3, 0, 10),
          // Hard desktop-control switch: absent/false in old settings files = OFF.
          computerUse: raw.computerUse === true,
          // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
          // are dropped here so they disappear from Settings → Plugins on reload.
          searchPlugins: searchPlugins.length > 0 ? searchPlugins : [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
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
              ...loadedChats.filter((c) => (c.messages?.length ?? 0) === 0).map((c) => c.id)
            ])
          ]
        });
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
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map(
              (p) => p.id === s2.settings.activeProviderId ? { ...p, ...patch } : p
            ),
            activeProviderId: s2.settings.activeProviderId
          }
        }));
        get().persist();
      },
      updateProvider: (id, patch) => {
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map(
              (p) => p.id === id ? normalizeProvider({ ...p, ...patch }) : p
            ),
            activeProviderId: s2.settings.activeProviderId
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
        set((s2) => ({
          settings: { ...s2.settings, providers: [...s2.settings.providers, provider] }
        }));
        get().persist();
        return id;
      },
      removeProvider: (id) => {
        set((s2) => {
          const providers = s2.settings.providers.filter((p) => p.id !== id);
          const out = providers.length > 0 ? providers : defaultProviders();
          const active = s2.settings.activeProviderId === id || !out.some((p) => p.id === s2.settings.activeProviderId) ? out[0].id : s2.settings.activeProviderId;
          return { settings: { ...s2.settings, providers: out, activeProviderId: active } };
        });
        get().persist();
      },
      setActiveProvider: (id) => {
        set((s2) => {
          if (!s2.settings.providers.some((p) => p.id === id)) return {};
          return { settings: { ...s2.settings, activeProviderId: id } };
        });
        get().persist();
      },
      setProviderModels: (id, models) => {
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map(
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
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => {
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
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => {
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
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => {
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
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => {
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
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => p.id === id ? { ...p, contextMap } : p)
          }
        }));
        get().persist();
      },
      setProviderPricingMap: (id, pricingMap) => {
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => p.id === id ? { ...p, pricingMap } : p)
          }
        }));
        get().persist();
      },
      setProviderReasoningMap: (id, reasoningMap) => {
        set((s2) => ({
          settings: {
            ...s2.settings,
            providers: s2.settings.providers.map((p) => p.id === id ? { ...p, reasoningMap } : p)
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
        set((s2) => ({
          chats: s2.chats.map((c) => {
            const owner = c.providerId ?? s2.settings.activeProviderId;
            if (owner !== providerId || !c.model || valid.has(bare(c.model))) return c;
            return { ...c, model: fallback };
          }),
          recentModels: s2.recentModels.filter(
            (r) => r.providerId !== providerId || valid.has(bare(r.model))
          )
        }));
        get().persist();
      },
      setMcpServers: (mcpServers) => {
        set((s2) => ({ settings: { ...s2.settings, mcpServers } }));
        get().persist();
      },
      addMcpServer: (name, cfg) => {
        set((s2) => {
          const mcpServers = { ...s2.settings.mcpServers ?? {}, [name]: cfg };
          return { settings: { ...s2.settings, mcpServers } };
        });
        get().persist();
        void saveMcp(name, cfg);
      },
      updateMcpServer: (name, cfg) => {
        set((s2) => {
          const mcpServers = { ...s2.settings.mcpServers ?? {}, [name]: cfg };
          return { settings: { ...s2.settings, mcpServers } };
        });
        get().persist();
        void saveMcp(name, cfg);
      },
      removeMcpServer: (name) => {
        if (get().builtinMcp.includes(name)) return;
        set((s2) => {
          const mcpServers = { ...s2.settings.mcpServers ?? {} };
          delete mcpServers[name];
          const mcpEnabled = (s2.settings.mcpEnabled ?? []).filter((n) => n !== name);
          return { settings: { ...s2.settings, mcpServers, mcpEnabled } };
        });
        get().persist();
        void deleteMcp(name);
      },
      setMcpEnabled: (name, on) => {
        set((s2) => {
          const cur = new Set(s2.settings.mcpEnabled ?? []);
          if (on) cur.add(name);
          else cur.delete(name);
          return { settings: { ...s2.settings, mcpEnabled: [...cur] } };
        });
        get().persist();
      },
      setSystemPrompt: (mode, text) => {
        set((s2) => ({
          settings: {
            ...s2.settings,
            systemPrompts: { ...s2.settings.systemPrompts ?? {}, [mode]: text }
          }
        }));
        get().persist();
      },
      removeMode: (id) => {
        set((s2) => {
          const modes = (s2.settings.modes ?? []).filter((m) => m.id !== id);
          const systemPrompts = { ...s2.settings.systemPrompts ?? {} };
          delete systemPrompts[id];
          return { settings: { ...s2.settings, modes, systemPrompts } };
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
      setVectorDbPath: (vectorDbPath) => {
        set({ vectorDbPath: (vectorDbPath ?? "").trim() });
        get().persist();
      },
      setDataPath: (dataPath) => {
        set({ dataPath: (dataPath ?? "").trim() });
        get().persist();
      },
      setWhisperModel: (m) => {
        set({ whisperModel: (m ?? "").trim() || "Systran/faster-whisper-medium" });
        get().persist();
      },
      setWhisperBaseUrl: (u) => {
        set({ whisperBaseUrl: (u ?? "").trim() });
        get().persist();
      },
      setSttProviderId: (id) => {
        set({ sttProviderId: (id ?? "").trim() || "local" });
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
      setEmbeddingModel: (m) => {
        set({ embeddingModel: (m ?? "").trim() || "intfloat/multilingual-e5-base" });
        get().persist();
      },
      setEmbeddingBaseUrl: (u) => {
        set({ embeddingBaseUrl: (u ?? "").trim() });
        get().persist();
      },
      setWebSearchAutoFetch: (n) => {
        const r = Math.round(n);
        set({ webSearchAutoFetch: Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 3 });
        get().persist();
      },
      setRagWebTtlDays: (d) => {
        set({ ragWebTtlDays: Math.max(1, Math.round(d) || 90) });
        get().persist();
      },
      setSubagentModel: (agent, model) => {
        set((s2) => {
          const subagentModels = { ...s2.subagentModels };
          if (model) subagentModels[agent] = model;
          else delete subagentModels[agent];
          return { subagentModels };
        });
        get().persist();
      },
      setMemoryTtlConfig: (c) => {
        set({
          cacheTtlMinutes: typeof c.cache === "number" && c.cache > 0 ? Math.round(c.cache) : get().cacheTtlMinutes
        });
        get().persist();
      },
      setHistoryLimit: (n) => {
        set({ historyLimit: Math.max(0, Math.round(n) || 0) });
        get().persist();
      },
      setSearchPlugins: (searchPlugins) => {
        set({ searchPlugins });
        get().persist();
      },
      setSearchConsole: (patch) => {
        set((s2) => ({ searchConsole: { ...s2.searchConsole, ...patch } }));
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
        set((s2) => ({
          terminalPanelOpen,
          terminalFullscreen: terminalPanelOpen ? s2.terminalFullscreen : false
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
      setRecentModels: (recentModels) => {
        set({ recentModels });
        get().persist();
      },
      addRecentModel: (model, providerId) => {
        const m = (model || "").trim();
        if (!m) return;
        const pid = providerId || "";
        const now = Date.now();
        set((s2) => {
          const prev = s2.recentModels.find((x) => x.model === m && x.providerId === pid);
          const pinned = prev?.pinned === true;
          const rest = s2.recentModels.filter((x) => x.model !== m || x.providerId !== pid);
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
        set((s2) => ({
          recentModels: s2.recentModels.filter((x) => x.model !== m || x.providerId !== pid || x.pinned)
        }));
        get().persist();
      },
      togglePinRecentModel: (model, providerId) => {
        const m = (model || "").trim();
        if (!m) return false;
        const pid = providerId || "";
        let pinnedNow = false;
        let changed = false;
        set((s2) => {
          const target = s2.recentModels.find((x) => x.model === m && x.providerId === pid);
          if (!target) return {};
          if (target.pinned) {
            changed = true;
            return { recentModels: sortRecentModels(s2.recentModels.map((x) => x.model === m && x.providerId === pid ? { ...x, pinned: void 0 } : x)) };
          }
          if (s2.recentModels.filter((x) => x.pinned).length >= MAX_PINNED_RECENT_MODELS) return {};
          pinnedNow = true;
          changed = true;
          return { recentModels: sortRecentModels(s2.recentModels.map((x) => x.model === m && x.providerId === pid ? { ...x, pinned: true } : x)) };
        });
        if (changed) get().persist();
        return pinnedNow;
      },
      newChat: (mode) => {
        const chat = makeChat(mode ?? "ask");
        const s2 = useStore2.getState();
        const prevRoot = s2.chats.find((c) => c.id === s2.activeChatId)?.root;
        const lastRoot = [...s2.chats].reverse().find((c) => c.root)?.root;
        chat.root = prevRoot ?? lastRoot ?? s2.root;
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
        set((s2) => {
          const workspaces = s2.workspaces.some((w) => w.key === key) ? s2.workspaces : [...s2.workspaces, ws];
          return { workspaces };
        });
        get().persist();
        return key;
      },
      setWorkspaceOrder: (keys) => {
        set((s2) => {
          const ordered = [...keys].map((k) => s2.workspaces.find((w) => w.key === k)).filter((w) => Boolean(w));
          const known = new Set(ordered.map((w) => w.key));
          for (const w of s2.workspaces) if (!known.has(w.key)) ordered.push(w);
          return { workspaces: ordered };
        });
        get().persist();
      },
      deleteChat: (id) => {
        set((s2) => {
          const chats = s2.chats.filter((c) => c.id !== id);
          const openChatIds = s2.openChatIds.filter((cid) => cid !== id);
          let activeChatId = s2.activeChatId;
          if (s2.activeChatId === id) {
            const idx = s2.openChatIds.indexOf(id);
            const remaining = openChatIds;
            activeChatId = remaining[Math.min(Math.max(idx - 1, 0), remaining.length - 1)] ?? chats[chats.length - 1]?.id ?? "";
            if (!remaining.includes(activeChatId) && activeChatId) remaining.push(activeChatId);
          }
          const finalOpen = openChatIds.includes(activeChatId) || !activeChatId ? openChatIds : [...openChatIds, activeChatId];
          persistOpenState(finalOpen, activeChatId);
          const validIds = new Set(chats.map((c) => c.id));
          const baseTree = s2.chatTree ?? buildFromList(s2.visibleChatIds, treeDirFromLayout(s2.chatLayout));
          const normalized = normalizeTree(removeChat(baseTree, id), validIds);
          const fallbackVisible = normalizeVisibleChats(s2.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTree = normalized ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s2.chatLayout)) : null);
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
          const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
          const chatWindowSizes = mirrors.chatWindowSizes;
          return {
            chats,
            activeChatId,
            openChatIds: finalOpen,
            visibleChatIds,
            chatWindowSizes,
            chatTree,
            deletedChatIds: [...s2.deletedChatIds, id],
            pinnedChats: s2.pinnedChats.filter((k) => k !== id),
            unreadChats: s2.unreadChats.filter((cid) => cid !== id)
          };
        });
        get().persist();
      },
      deleteWorkspace: (key) => {
        set((s2) => {
          const chats = s2.chats.filter((c) => workspaceKey(c.root ?? "") !== key);
          const workspaces = s2.workspaces.filter((w) => w.key !== key);
          const doomedIds = new Set(
            s2.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.id)
          );
          const pinnedWorkspaces = s2.pinnedWorkspaces.filter((k) => k !== key);
          const pinnedChats = s2.pinnedChats.filter((k) => !doomedIds.has(k));
          const activeChatId = s2.chats.some((c) => c.id === s2.activeChatId && workspaceKey(c.root ?? "") !== key) ? s2.activeChatId : chats[chats.length - 1]?.id ?? "";
          const openChatIds = s2.openChatIds.filter((cid) => !doomedIds.has(cid));
          if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId);
          persistOpenState(openChatIds, activeChatId);
          const validIds = new Set(chats.map((c) => c.id));
          const baseTreeWs = s2.chatTree ?? buildFromList(s2.visibleChatIds, treeDirFromLayout(s2.chatLayout));
          let pruned = baseTreeWs;
          for (const dead of doomedIds) pruned = removeChat(pruned, dead);
          const normalizedWs = normalizeTree(pruned, validIds);
          const fallbackWs = normalizeVisibleChats(s2.visibleChatIds.filter((cid) => !doomedIds.has(cid)), validIds, activeChatId);
          const chatTreeWs = normalizedWs ?? (fallbackWs.length > 0 ? buildFromList(fallbackWs, treeDirFromLayout(s2.chatLayout)) : null);
          const mirrorsWs = persistTreeMirrors(chatTreeWs, s2.chatLayout);
          const visibleChatIds = mirrorsWs.visibleChatIds.length > 0 ? mirrorsWs.visibleChatIds : fallbackWs;
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
            unreadChats: s2.unreadChats.filter((cid) => !doomedIds.has(cid)),
            deletedChatIds: [
              ...s2.deletedChatIds,
              ...s2.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.id)
            ],
            deletedWorkspaceRoots: [
              ...s2.deletedWorkspaceRoots,
              ...s2.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.root ?? "")
            ]
          };
        });
        get().persist();
      },
      setWorkspaceColor: (key, color) => {
        set((s2) => {
          const workspaceColors = { ...s2.workspaceColors };
          if (color) workspaceColors[key] = color;
          else delete workspaceColors[key];
          return { workspaceColors };
        });
        get().persist();
      },
      togglePinWorkspace: (key) => {
        set((s2) => {
          const wasPinned = s2.pinnedWorkspaces.includes(key);
          const pinnedWorkspaces = wasPinned ? s2.pinnedWorkspaces.filter((k) => k !== key) : [key, ...s2.pinnedWorkspaces];
          return { pinnedWorkspaces };
        });
        get().persist();
      },
      renameWorkspace: (key, label) => {
        set((s2) => ({
          workspaces: s2.workspaces.map(
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
        const prevRoot = prev?.root ?? get().chats.find((c) => workspaceKey(c.root ?? "") === key)?.root ?? "";
        if (nextKey === key) {
          set((s2) => ({
            workspaces: s2.workspaces.map(
              (w) => w.key === key ? { ...w, root: nextRoot || null } : w
            ),
            chats: s2.chats.map(
              (c) => workspaceKey(c.root ?? "") === key ? { ...c, root: nextRoot || void 0, updatedAt: Date.now() } : c
            ),
            root: s2.root === prevRoot ? nextRoot : s2.root
          }));
          get().persist();
          return key;
        }
        if (!prev && get().chats.every((c) => workspaceKey(c.root ?? "") !== key)) {
          get().createWorkspace(nextRoot);
          return nextKey;
        }
        set((s2) => {
          const targetExists = s2.workspaces.some((w) => w.key === nextKey);
          const prevLabel = prev?.label ?? workspaceLabel(prevRoot);
          const label = prev && prevLabel !== workspaceLabel(prevRoot) ? prevLabel : workspaceLabel(nextRoot);
          let workspaces;
          if (targetExists) {
            workspaces = s2.workspaces.filter((w) => w.key !== key).map((w) => w.key === nextKey ? { ...w, root: nextRoot || null } : w);
          } else {
            workspaces = s2.workspaces.map(
              (w) => w.key === key ? { ...w, key: nextKey, root: nextRoot || null, label } : w
            );
          }
          const workspaceColors = { ...s2.workspaceColors };
          if (workspaceColors[key] !== void 0 && workspaceColors[nextKey] === void 0) {
            workspaceColors[nextKey] = workspaceColors[key];
          }
          delete workspaceColors[key];
          return {
            workspaces,
            chats: s2.chats.map(
              (c) => workspaceKey(c.root ?? "") === key ? { ...c, root: nextRoot || void 0, updatedAt: Date.now() } : c
            ),
            workspaceColors,
            pinnedWorkspaces: s2.pinnedWorkspaces.map((k) => k === key ? nextKey : k),
            root: s2.root === prevRoot ? nextRoot : s2.root,
            deletedWorkspaceRoots: prevRoot ? [...s2.deletedWorkspaceRoots, prevRoot] : s2.deletedWorkspaceRoots
          };
        });
        get().persist();
        return nextKey;
      },
      togglePinChat: (id) => {
        set((s2) => {
          const wasPinned = s2.pinnedChats.includes(id);
          const pinnedChats = wasPinned ? s2.pinnedChats.filter((k) => k !== id) : [id, ...s2.pinnedChats];
          return { pinnedChats };
        });
        get().persist();
      },
      setActiveChat: (id) => {
        set((s2) => {
          const openChatIds = s2.openChatIds.includes(id) ? s2.openChatIds : [...s2.openChatIds, id];
          persistOpenState(openChatIds, id);
          const single = leafCount(s2.chatTree) <= 1 && s2.visibleChatIds.length <= 1;
          let chatTree = s2.chatTree;
          let visibleChatIds = s2.visibleChatIds;
          let chatWindowSizes = s2.chatWindowSizes;
          let chatLayout = s2.chatLayout;
          if (single) {
            visibleChatIds = [id];
            chatTree = null;
            persistVisibleChats(visibleChatIds);
            persistChatTree(null);
          } else if (!containsChat(chatTree, id)) {
            const base = ensureTree(chatTree, visibleChatIds, s2.chatLayout);
            chatTree = openBeside(base, id, s2.activeChatId, smartAppendDir(s2.chatLayout));
            const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
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
            unreadChats: s2.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      openChat: (id) => {
        set((s2) => {
          if (!s2.chats.some((c) => c.id === id)) return {};
          const openChatIds = s2.openChatIds.includes(id) ? s2.openChatIds : [...s2.openChatIds, id];
          persistOpenState(openChatIds, id);
          const single = leafCount(s2.chatTree) <= 1 && s2.visibleChatIds.length <= 1;
          let chatTree = s2.chatTree;
          let visibleChatIds = s2.visibleChatIds;
          let chatWindowSizes = s2.chatWindowSizes;
          let chatLayout = s2.chatLayout;
          if (single) {
            visibleChatIds = [id];
            chatTree = null;
            persistVisibleChats(visibleChatIds);
            persistChatTree(null);
          } else if (!containsChat(chatTree, id)) {
            const base = ensureTree(chatTree, visibleChatIds, s2.chatLayout);
            chatTree = openBeside(base, id, s2.activeChatId, smartAppendDir(s2.chatLayout));
            const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
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
            unreadChats: s2.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      closeChatTab: (id) => {
        set((s2) => {
          if (!s2.openChatIds.includes(id)) return {};
          const idx = s2.openChatIds.indexOf(id);
          const openChatIds = s2.openChatIds.filter((cid) => cid !== id);
          let activeChatId = s2.activeChatId;
          if (s2.activeChatId === id) {
            activeChatId = openChatIds[Math.min(idx, openChatIds.length - 1)] ?? "";
          }
          persistOpenState(openChatIds, activeChatId);
          const validIds = new Set(s2.chats.map((c) => c.id));
          const baseTreeCt = s2.chatTree ?? buildFromList(s2.visibleChatIds, treeDirFromLayout(s2.chatLayout));
          const normalizedCt = normalizeTree(removeChat(baseTreeCt, id), validIds);
          const fallbackCt = normalizeVisibleChats(s2.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s2.chatLayout)) : null);
          const mirrorsCt = persistTreeMirrors(chatTreeCt, s2.chatLayout);
          const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
          const recentlyClosedChatTabs = s2.chats.some((c) => c.id === id) ? [{ id, at: Date.now() }, ...s2.recentlyClosedChatTabs.filter((r) => r.id !== id)].slice(0, 8) : s2.recentlyClosedChatTabs;
          return { openChatIds, activeChatId, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
        });
        persistSoon();
      },
      closeInactiveChatTabs: () => {
        let closed = [];
        set((s2) => {
          const streaming = new Set(
            s2.chats.filter((c) => c.messages.some((m) => m.streaming || m.retry?.reconnecting === true)).map((c) => c.id)
          );
          const visible = new Set(s2.chatTree ? collectChatIds(s2.chatTree) : s2.visibleChatIds);
          const toClose = s2.openChatIds.filter(
            (id) => id !== s2.activeChatId && !streaming.has(id) && !visible.has(id)
          );
          if (toClose.length === 0) return {};
          closed = toClose;
          const drop = new Set(toClose);
          const openChatIds = s2.openChatIds.filter((cid) => !drop.has(cid));
          persistOpenState(openChatIds, s2.activeChatId);
          const validIds = new Set(s2.chats.map((c) => c.id));
          let baseTreeCt = s2.chatTree ?? buildFromList(s2.visibleChatIds, treeDirFromLayout(s2.chatLayout));
          for (const id of toClose) {
            if (!baseTreeCt) break;
            baseTreeCt = removeChat(baseTreeCt, id);
          }
          const normalizedCt = normalizeTree(baseTreeCt, validIds);
          const fallbackCt = normalizeVisibleChats(s2.visibleChatIds.filter((cid) => !drop.has(cid)), validIds, s2.activeChatId);
          const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s2.chatLayout)) : null);
          const mirrorsCt = persistTreeMirrors(chatTreeCt, s2.chatLayout);
          const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
          const now = Date.now();
          const kept = toClose.filter((id) => s2.chats.some((c) => c.id === id));
          const recentlyClosedChatTabs = [
            ...kept.map((id, i) => ({ id, at: now - i })),
            ...s2.recentlyClosedChatTabs.filter((r) => !drop.has(r.id))
          ].slice(0, 8);
          return { openChatIds, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
        });
        persistSoon();
        return closed;
      },
      reopenChatTab: (id) => {
        set((s2) => ({
          recentlyClosedChatTabs: s2.recentlyClosedChatTabs.filter((r) => r.id !== id)
        }));
        get().openChat(id);
      },
      moveChatTab: (fromId, toId, after = false) => {
        set((s2) => {
          const from = s2.openChatIds.indexOf(fromId);
          if (from === -1 || !s2.openChatIds.includes(toId) || fromId === toId) return {};
          const rest = s2.openChatIds.filter((cid) => cid !== fromId);
          let dest = rest.indexOf(toId) + (after ? 1 : 0);
          dest = Math.max(0, Math.min(rest.length, dest));
          const openChatIds = rest.slice();
          openChatIds.splice(dest, 0, fromId);
          persistOpenState(openChatIds, fromId);
          return {
            openChatIds,
            activeChatId: fromId,
            unreadChats: s2.unreadChats.filter((cid) => cid !== fromId)
          };
        });
        persistSoon();
      },
      openInWindow: (id) => {
        set((s2) => {
          if (!s2.chats.some((c) => c.id === id)) return {};
          const base = ensureTree(s2.chatTree, s2.visibleChatIds.length > 0 ? s2.visibleChatIds : [s2.activeChatId], s2.chatLayout);
          const openChatIds = s2.openChatIds.includes(id) ? s2.openChatIds : [...s2.openChatIds, id];
          persistOpenState(openChatIds, id);
          const chatTree = containsChat(base, id) ? base : openBeside(base, id, s2.activeChatId, smartAppendDir(s2.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
          return {
            activeChatId: id,
            openChatIds,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            unreadChats: s2.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      closeWindow: (id) => {
        set((s2) => {
          const treeIds = s2.chatTree ? collectChatIds(s2.chatTree) : [];
          const ids = treeIds.length > 0 ? treeIds : s2.visibleChatIds;
          if (!ids.includes(id) && !s2.visibleChatIds.includes(id)) return {};
          if ((/* @__PURE__ */ new Set([...treeIds, ...s2.visibleChatIds])).size <= 1 && ids.length <= 1) return {};
          const idx = ids.indexOf(id);
          const base = s2.chatTree ?? buildFromList(s2.visibleChatIds, treeDirFromLayout(s2.chatLayout));
          const pruned = removeChat(base, id);
          const fallbackVisible = (s2.visibleChatIds.length > 0 ? s2.visibleChatIds : ids).filter((cid) => cid !== id);
          const chatTree = pruned ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s2.chatLayout)) : null);
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
          const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
          let activeChatId = s2.activeChatId;
          if (s2.activeChatId === id) {
            activeChatId = visibleChatIds[Math.min(Math.max(idx, 0), visibleChatIds.length - 1)] ?? "";
          }
          if (activeChatId !== s2.activeChatId) persistOpenState(s2.openChatIds, activeChatId);
          const windowFullscreenId = s2.windowFullscreenId === id ? null : s2.windowFullscreenId;
          if (s2.windowFullscreenId === id) persistWindowFullscreen(null);
          return {
            visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            activeChatId,
            windowFullscreenId,
            unreadChats: s2.unreadChats.filter((cid) => cid !== activeChatId)
          };
        });
      },
      focusWindow: (id) => {
        set((s2) => {
          if (!s2.chats.some((c) => c.id === id)) return {};
          if (s2.activeChatId === id) return {};
          const openChatIds = s2.openChatIds.includes(id) ? s2.openChatIds : [...s2.openChatIds, id];
          persistOpenState(openChatIds, id);
          let chatTree = s2.chatTree;
          let visibleChatIds = s2.visibleChatIds;
          let chatWindowSizes = s2.chatWindowSizes;
          let chatLayout = s2.chatLayout;
          if (!containsChat(chatTree, id)) {
            if (leafCount(chatTree) <= 1 && visibleChatIds.length <= 1) {
              visibleChatIds = [id];
              chatTree = null;
              persistVisibleChats(visibleChatIds);
              persistChatTree(null);
            } else {
              const base = ensureTree(chatTree, visibleChatIds, s2.chatLayout);
              chatTree = openBeside(base, id, s2.activeChatId, smartAppendDir(s2.chatLayout));
              const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
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
            unreadChats: s2.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      moveWindow: (fromId, toId, after = false) => {
        set((s2) => {
          if (s2.chatTree) {
            const base = ensureTree(s2.chatTree, s2.visibleChatIds, s2.chatLayout);
            if (!base) return {};
            const flatDir = base.kind === "split" ? base.dir : treeDirFromLayout(s2.chatLayout);
            const isFlat = base.kind !== "split" || base.children.every((c) => c.kind === "leaf");
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
            const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
            return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
          }
          const from = s2.visibleChatIds.indexOf(fromId);
          if (from === -1 || !s2.visibleChatIds.includes(toId) || fromId === toId) return {};
          const rest = s2.visibleChatIds.filter((cid) => cid !== fromId);
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
        set((s2) => {
          const ids = s2.chatTree ? collectChatIds(s2.chatTree) : s2.visibleChatIds;
          if (!ids.includes(id)) return {};
          if (s2.chatTree) {
            const chatTree = setChatSize(s2.chatTree, id, clamped);
            const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
            return { chatTree, chatWindowSizes: mirrors.chatWindowSizes, visibleChatIds: mirrors.visibleChatIds, chatLayout: mirrors.chatLayout };
          }
          const chatWindowSizes = { ...s2.chatWindowSizes, [id]: clamped };
          persistWindowSizes(chatWindowSizes);
          return { chatWindowSizes };
        });
      },
      setChatLayout: (layout) => {
        const next = normalizeChatLayout(layout);
        set((s2) => {
          if (s2.chatTree && s2.chatTree.kind === "split") {
            const chatTree = setRootDir(s2.chatTree, next === "horizontal" ? "row" : "col");
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
        set((s2) => {
          if (!s2.chats.some((c) => c.id === dragChatId)) return {};
          if (!s2.chats.some((c) => c.id === targetChatId)) return {};
          const base = ensureTree(s2.chatTree, s2.visibleChatIds.length > 0 ? s2.visibleChatIds : [targetChatId], s2.chatLayout);
          if (base && !containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX && pos !== "center") {
            const openChatIds2 = s2.openChatIds.includes(dragChatId) ? s2.openChatIds : [...s2.openChatIds, dragChatId];
            persistOpenState(openChatIds2, s2.activeChatId);
            return { openChatIds: openChatIds2 };
          }
          const openChatIds = s2.openChatIds.includes(dragChatId) ? s2.openChatIds : [...s2.openChatIds, dragChatId];
          persistOpenState(openChatIds, dragChatId);
          const chatTree = dropOnto(base, dragChatId, targetChatId, pos);
          if (!chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
          if (s2.windowFullscreenId) persistWindowFullscreen(null);
          return {
            activeChatId: dragChatId,
            openChatIds,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            windowFullscreenId: null,
            unreadChats: s2.unreadChats.filter((cid) => cid !== dragChatId)
          };
        });
        persistSoon();
      },
      dropChatOntoRoot: (dragChatId, pos) => {
        if (!dragChatId) return;
        if (pos === "center") return;
        set((s2) => {
          if (!s2.chats.some((c) => c.id === dragChatId)) return {};
          const base = ensureTree(s2.chatTree, s2.visibleChatIds.length > 0 ? s2.visibleChatIds : [dragChatId], s2.chatLayout);
          if (!base) return {};
          if (!containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX) {
            const openChatIds2 = s2.openChatIds.includes(dragChatId) ? s2.openChatIds : [...s2.openChatIds, dragChatId];
            persistOpenState(openChatIds2, s2.activeChatId);
            return { openChatIds: openChatIds2 };
          }
          const openChatIds = s2.openChatIds.includes(dragChatId) ? s2.openChatIds : [...s2.openChatIds, dragChatId];
          persistOpenState(openChatIds, dragChatId);
          const chatTree = dropOntoRoot(base, dragChatId, pos);
          if (!chatTree || chatTree === base) return { openChatIds };
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
          if (s2.windowFullscreenId) persistWindowFullscreen(null);
          return {
            activeChatId: dragChatId,
            openChatIds,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            windowFullscreenId: null,
            unreadChats: s2.unreadChats.filter((cid) => cid !== dragChatId)
          };
        });
        persistSoon();
      },
      setTreeNodeSize: (nodeId, size) => {
        set((s2) => {
          if (!s2.chatTree) return {};
          const chatTree = setNodeSize(s2.chatTree, nodeId, size);
          if (!chatTree || chatTree === s2.chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
          return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
        });
      },
      resizeTreePair: (parentId, firstId, secondId, firstSize, secondSize) => {
        set((s2) => {
          if (!s2.chatTree) return {};
          const chatTree = resizePair(s2.chatTree, parentId, firstId, secondId, firstSize, secondSize);
          if (!chatTree || chatTree === s2.chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s2.chatLayout);
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
        set((s2) => {
          persistChatFullscreen(!s2.chatFullscreen);
          return { chatFullscreen: !s2.chatFullscreen };
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
        set((s2) => ({
          chats: s2.chats.map((c) => {
            if (c.id !== id) return c;
            const label = MODE_LABELS[mode] ?? mode;
            const modeMsg = {
              id: uid(),
              role: "system",
              content: `[Mode switched to ${label} \u2014 the next user message runs in ${label} mode.]`,
              modeSwitch: true,
              createdAt: Date.now()
            };
            return { ...c, mode, messages: [...c.messages, modeMsg], updatedAt: Date.now() };
          })
        }));
        get().persist();
      },
      setChatModeQuiet: (id, mode) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, mode, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      setGoal: (id, condition) => {
        const text = (condition ?? "").trim();
        if (!text) return;
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id ? { ...c, goal: { condition: text, active: true, paused: false, stopped: false, startedAt: Date.now(), turns: 0 }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      clearGoal: (id) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, goal: null, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      pauseGoal: (id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id && c.goal?.active ? { ...c, goal: { ...c.goal, paused: true, stopped: false }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      resumeGoal: (id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id && c.goal?.active ? { ...c, goal: { ...c.goal, paused: false, stopped: false }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      stopGoal: (id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id && c.goal?.active && !c.goal.paused ? { ...c, goal: { ...c.goal, stopped: true }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      rearmGoal: (id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id && c.goal?.active && c.goal.stopped ? { ...c, goal: { ...c.goal, stopped: false }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      incrementGoalTurn: (id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id && c.goal?.active && !c.goal.paused ? { ...c, goal: { ...c.goal, turns: (c.goal.turns ?? 0) + 1 } } : c
          )
        }));
        get().persist();
      },
      setChatRoot: (id, root) => {
        set((s2) => ({
          root: s2.activeChatId === id ? root : s2.root,
          chats: s2.chats.map((c) => c.id === id ? { ...c, root, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      setChatDraft: (id, patch) => {
        set((s2) => {
          const idx = s2.chats.findIndex((c) => c.id === id);
          if (idx === -1) return {};
          const cur = s2.chats[idx];
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
          const chats = s2.chats.slice();
          chats[idx] = { ...cur, draft: next };
          return { chats };
        });
      },
      setChatThinkingLevel: (id, level) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, thinkingLevel: level, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      setChatProvider: (id, providerId, model) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, providerId, model, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      renameChat: (id, title) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, title, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      forkSection: (messageId, sectionTitle, sectionContent) => {
        const s2 = useStore2.getState();
        const src = s2.chats.find((c) => c.messages.some((m) => m.id === messageId));
        if (!src) return;
        const chatId = s2.newChatInRoot(src.root ?? "", src.mode);
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
        const src = get().chats.find((c) => c.messages.some((m) => m.id === messageId));
        if (!src) return null;
        const idx = src.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return null;
        const chatId = get().newChatInRoot(src.root ?? "", src.mode);
        if (src.providerId) {
          get().setChatProvider(chatId, src.providerId, src.model ?? "");
        }
        const cut = src.messages.slice(0, idx + 1).map((m) => ({ ...m }));
        set((st) => ({
          chats: st.chats.map(
            (c) => c.id === chatId ? {
              ...c,
              messages: cut,
              title: `${src.title} (fork)`.slice(0, 80),
              thinkingLevel: src.thinkingLevel,
              updatedAt: Date.now()
            } : c
          ),
          activeChatId: chatId
        }));
        get().persist();
        get().setFocusComposer(true);
        return chatId;
      },
      addMessage: (chatId, message) => {
        const id = uid();
        const full = { ...message, id, createdAt: Date.now() };
        const prev = get().chats.find((c) => c.id === chatId);
        const autoTitle = message.content.slice(0, 48);
        const hasPriorUser = !!prev?.messages.some((m) => m.role === "user");
        const shouldTitle = message.role === "user" && !!prev && !hasPriorUser && prev.title === "New chat" && message.content.trim() !== "";
        set((s2) => {
          if (message.role === "user") {
            const st = stackFor(chatId);
            st.redo = [];
          }
          const chats = s2.chats.map(
            (c) => c.id === chatId ? {
              ...c,
              messages: [...c.messages, full],
              // The sidebar sorts by the most recent message activity: sending
              // a user message, or a completed assistant reply, floats the
              // chat to the top of its group. Streaming assistant deltas stay
              // put mid-run so two concurrent chats don't keep swapping places
              // while the agent streams — the final setStreaming(false) bumps.
              updatedAt: !message.streaming && (message.role === "user" || message.role === "assistant") ? Date.now() : c.updatedAt,
              title: c.messages.length === 0 && message.role === "user" ? message.content.slice(0, 48) : c.title
            } : c
          );
          return { chats };
        });
        get().persist();
        if (shouldTitle) {
          console.info("[title] generating title for new chat", chatId.slice(-6));
          void (async () => {
            try {
              const st = get();
              const chat = st.chats.find((c) => c.id === chatId);
              const provider = st.settings.providers.find(
                (p) => p.id === (chat?.providerId ?? st.settings.activeProviderId)
              ) ?? st.settings.providers[0];
              if (!provider) return;
              const res = await requestChatTitle({
                provider,
                subagentModels: st.subagentModels ?? {},
                providers: Object.fromEntries(
                  (st.settings.providers ?? []).map((p) => [p.id, p])
                ),
                text: message.content.slice(0, 1e3),
                chatId
              });
              const title = typeof res?.title === "string" ? res.title.trim() : "";
              if (title) {
                try {
                  const cur = get().chats.find((c) => c.id === chatId);
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
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === chatId ? { ...c, messages: c.messages.filter((m) => m.id !== id) } : c
          )
        }));
        get().persist();
      },
      queueMessage: (chatId, msg) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === chatId ? { ...c, queued: [...c.queued ?? [], { ...msg, createdAt: Date.now() }] } : c
          )
        }));
        get().persist();
      },
      removeQueuedMessage: (chatId, id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === chatId ? { ...c, queued: (c.queued ?? []).filter((q) => q.id !== id) } : c
          )
        }));
        get().persist();
      },
      clearQueue: (chatId) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === chatId ? { ...c, queued: [] } : c)
        }));
        get().persist();
      },
      markQueuedSent: (chatId, id) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === chatId ? { ...c, queued: (c.queued ?? []).map((q) => q.id === id ? { ...q, sent: true } : q) } : c
          )
        }));
        get().persist();
      },
      updateMessage: (id, patch) => {
        set((s2) => {
          const targetChat = s2.chats.find((c) => c.messages.some((m) => m.id === id));
          if (!targetChat) return {};
          const msg = targetChat.messages.find((m) => m.id === id);
          const completes = msg.streaming === true && patch.streaming === false;
          const updatedChat = {
            ...targetChat,
            messages: targetChat.messages.map((m) => m.id === id ? { ...m, ...patch } : m),
            updatedAt: completes ? Date.now() : targetChat.updatedAt
          };
          const unreadChats = completes && targetChat.id !== s2.activeChatId && !s2.unreadChats.includes(targetChat.id) ? [...s2.unreadChats, targetChat.id] : s2.unreadChats;
          return {
            chats: s2.chats.map((c) => c.id === targetChat.id ? updatedChat : c),
            unreadChats
          };
        });
        maybePersistMidStream();
      },
      appendMessageSegments: (id, segments) => {
        if (!segments || segments.length === 0) return false;
        let added = false;
        set((s2) => {
          const targetChat = s2.chats.find((c) => c.messages.some((m) => m.id === id));
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
            chats: s2.chats.map(
              (c) => c.id === targetChat.id ? {
                ...c,
                messages: c.messages.map(
                  (m) => m.id === id ? { ...m, segments: next } : m
                )
              } : c
            )
          };
        });
        if (added) maybePersistMidStream();
        return added;
      },
      accrueChatUsage: (chatId, providerId, model, delta) => {
        const hasTokens = (delta.input || 0) > 0 || (delta.output || 0) > 0 || (delta.cacheRead || 0) > 0 || (delta.cacheWrite || 0) > 0;
        if (!hasTokens) return;
        set((s2) => ({
          chats: s2.chats.map((c) => {
            if (c.id !== chatId) return c;
            const entries = [...c.usage?.entries ?? []];
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
            const working = c.messages.some((m) => m.streaming);
            return { ...c, usage: { entries }, updatedAt: working ? c.updatedAt : Date.now() };
          })
        }));
        persistSoon();
      },
      resetChatUsage: (chatId) => {
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === chatId ? { ...c, usage: void 0, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      setChatPendingAsk: (chatId, req) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === chatId ? { ...c, pendingAsk: req } : c)
        }));
      },
      setChatPendingPermission: (chatId, req) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === chatId ? { ...c, pendingPermission: req } : c)
        }));
      },
      setChatCompacting: (id, compacting) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, compacting } : c)
        }));
      },
      setChatCompactNotice: (id, compactNotice) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, compactNotice } : c)
        }));
      },
      setChatCompactError: (id, compactError) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, compactError } : c)
        }));
      },
      setChatCmdError: (id, cmdError) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, cmdError } : c)
        }));
      },
      setChatLiveError: (id, liveError) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, liveError } : c)
        }));
      },
      setChatTtsError: (id, ttsError) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, ttsError } : c)
        }));
      },
      setChatSkillNotice: (id, skillNotice) => {
        set((s2) => ({
          chats: s2.chats.map((c) => c.id === id ? { ...c, skillNotice } : c)
        }));
      },
      docRev: {},
      bumpDocRev: (absPath) => {
        set((s2) => ({
          docRev: { ...s2.docRev, [absPath]: (s2.docRev[absPath] ?? 0) + 1 }
        }));
      },
      setChatScrollPos: (id, pos) => {
        set((s2) => ({
          // Deliberately NOT bumping updatedAt: scrolling shouldn't reorder chats.
          chats: s2.chats.map((c) => c.id === id ? { ...c, scrollPos: pos } : c)
        }));
        get().persist();
      },
      // In-memory-only variant: updates the store WITHOUT persisting. Used by the
      // `coder:flush-ui` handler so a chat panel can push its ref-held scroll
      // position into the store right before a flush writes the snapshot — no
      // redundant write, no recursion into persist().
      setChatScrollPosMem: (id, pos) => {
        set((s2) => {
          const cur = s2.chats.find((c) => c.id === id)?.scrollPos ?? null;
          const same = cur === null && pos === null || cur !== null && pos !== null && cur.id === pos.id && cur.offset === pos.offset && cur.atBottom === pos.atBottom;
          if (same) return {};
          return {
            chats: s2.chats.map((c) => c.id === id ? { ...c, scrollPos: pos } : c)
          };
        });
      },
      setPrefixNotice: (prefixNotice) => {
        set({ prefixNotice });
      },
      markToolReverted: (messageId, index) => {
        set((s2) => ({
          chats: s2.chats.map((c) => {
            const has = c.messages.some((m) => m.id === messageId);
            if (!has) return c;
            return {
              ...c,
              messages: c.messages.map(
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
        set((s2) => ({
          chats: s2.chats.map(
            (c) => c.id === id ? { ...c, messages: [], usage: void 0, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      truncateTo: (messageId) => {
        const s2 = get();
        const target = s2.chats.find((c) => c.messages.some((m) => m.id === messageId));
        if (!target) return false;
        const idx = target.messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return false;
        const targetId = target.id;
        set((st) => ({
          chats: st.chats.map(
            (c) => c.id === targetId ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() } : c
          )
        }));
        get().persist();
        return true;
      },
      compactChat: (id, summary, keep = 0) => {
        set((s2) => ({
          chats: s2.chats.map((c) => {
            if (c.id !== id) return c;
            const nonSys = c.messages.filter((m) => m.role !== "system");
            const recentStart = Math.max(nonSys.length - keep, 0);
            const compactedIds = new Set(
              nonSys.slice(0, recentStart).map((m) => m.id)
            );
            for (const m of c.messages) {
              if (m.streaming) compactedIds.delete(m.id);
            }
            for (const m of c.messages) {
              if (m.role === "system") compactedIds.add(m.id);
            }
            const messages = c.messages.map(
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
              ...c,
              messages: withSeg,
              updatedAt: Date.now()
            };
          })
        }));
        get().persist();
      },
      undoMessage: () => {
        const s2 = get();
        const chat = s2.chats.find((c) => c.id === s2.activeChatId);
        if (!chat || chat.messages.length === 0) return false;
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
        st.undo.push(removed);
        st.redo = [];
        set((stt) => ({
          chats: stt.chats.map(
            (c) => c.id === chat.id ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() } : c
          )
        }));
        get().persist();
        return true;
      },
      redoMessage: () => {
        const s2 = get();
        const chat = s2.chats.find((c) => c.id === s2.activeChatId);
        if (!chat) return false;
        const st = stackFor(chat.id);
        const exchange = st.undo.pop();
        if (!exchange) return false;
        st.redo.push(exchange);
        set((stt) => ({
          chats: stt.chats.map(
            (c) => c.id === chat.id ? { ...c, messages: [...c.messages, ...exchange], updatedAt: Date.now() } : c
          )
        }));
        get().persist();
        return true;
      },
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setStreaming: (active, thinking) => set((s2) => {
        if (s2.isStreaming === active && s2.isThinking === thinking) return {};
        return { isStreaming: active, isThinking: thinking };
      }),
      setOutsideAllowed: (allowed) => set({ outsideAllowed: allowed }),
      addOutsideFolder: (folder) => set((s2) => ({
        outsideFolders: folder && !s2.outsideFolders.includes(folder) ? [...s2.outsideFolders, folder] : s2.outsideFolders
      })),
      setComputerUse: (v) => set({ computerUse: v }),
      anyStreaming: () => get().chats.some((c) => c.messages.some((m) => m.streaming)),
      setCompactAtPercent: (percent) => {
        set((s2) => ({ settings: { ...s2.settings, compactAtPercent: percent } }));
        get().persist();
      }
    }));
    api.onSidecarChanged(() => {
      void useStore2.getState().load();
    });
  }
});

// tests/forkSection.test.ts
globalThis.window = {
  addEventListener: () => {
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return void 0;
        return async () => {
        };
      }
    }
  )
};
var { useStore: useStore3 } = await Promise.resolve().then(() => (init_store(), store_exports));
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
var srcId = useStore3.getState().newChat("ask");
useStore3.getState().addMessage(srcId, { role: "user", content: "\u0633\u0648\u0627\u0644 \u0627\u0648\u0644" });
useStore3.getState().addMessage(srcId, {
  role: "assistant",
  content: "## \u0628\u062E\u0634 \u0627\u0644\u0641\n\n\u0645\u062A\u0646 \u0627\u0644\u0641\n\n## \u0628\u062E\u0634 \u0628\n\n\u0645\u062A\u0646 \u0628"
});
var srcChat = useStore3.getState().chats.find((c) => c.id === srcId);
var srcMsg = srcChat.messages.find((m) => m.role === "assistant");
console.log("1) forkSection \u06CC\u06A9 \u0686\u062A \u062C\u062F\u06CC\u062F \u0628\u0627 \u0632\u0645\u06CC\u0646\u0647 \u0628\u062E\u0634 \u0645\u06CC\u0633\u0627\u0632\u062F:");
useStore3.getState().forkSection(srcMsg.id, "\u0628\u062E\u0634 \u0628", "\u0645\u062A\u0646 \u0628");
var s = useStore3.getState();
var newChat = s.chats.find((c) => c.id === s.activeChatId);
check("\u0686\u062A \u062C\u062F\u06CC\u062F \u0633\u0627\u062E\u062A\u0647 \u0634\u062F", !!newChat && newChat.id !== srcId);
check("\u062A\u06CC\u062A\u0631 \u0686\u062A = \u062A\u06CC\u062A\u0631 \u0628\u062E\u0634", newChat.title === "\u0628\u062E\u0634 \u0628", newChat.title);
check("\u0645\u0648\u062F \u06CC\u06A9\u0633\u0627\u0646 \u0627\u0633\u062A", newChat.mode === srcChat.mode, newChat.mode);
check("\u06CC\u06A9 \u067E\u06CC\u0627\u0645 \u0632\u0645\u06CC\u0646\u0647 \u062F\u0627\u0631\u062F", newChat.messages.length === 1, newChat.messages.length);
check("\u067E\u06CC\u0627\u0645 \u0632\u0645\u06CC\u0646\u0647 role=user \u0627\u0633\u062A", newChat.messages[0]?.role === "user");
check("\u0645\u062A\u0646 \u0632\u0645\u06CC\u0646\u0647 \u0634\u0627\u0645\u0644 \u0645\u062D\u062A\u0648\u0627\u06CC \u0628\u062E\u0634 \u0627\u0633\u062A", newChat.messages[0]?.content.includes("\u0645\u062A\u0646 \u0628"));
check("\u0645\u062A\u0646 \u0632\u0645\u06CC\u0646\u0647 \u0628\u0631\u0686\u0633\u0628 \u062F\u0627\u0631\u062F", newChat.messages[0]?.content.startsWith("\u{1F4CC} \u0628\u062E\u0634 \xAB\u0628\u062E\u0634 \u0628\xBB"));
check("activeChatId \u0628\u0647 \u0686\u062A \u062C\u062F\u06CC\u062F \u0631\u0641\u062A", s.activeChatId === newChat.id);
check("focusComposer \u0641\u0639\u0627\u0644 \u0634\u062F", s.focusComposer === true);
check("\u0686\u062A \u0645\u0628\u062F\u0623 \u062F\u0633\u062A \u0646\u062E\u0648\u0631\u062F", useStore3.getState().chats.find((c) => c.id === srcId).messages.length === 2);
console.log("2) messageId \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u2192 \u0647\u06CC\u0686 \u06A9\u0627\u0631\u06CC \u0646\u0645\u06CC\u06A9\u0646\u062F:");
var before = useStore3.getState().chats.length;
useStore3.getState().forkSection("does-not-exist", "x", "y");
check("\u0686\u062A \u062C\u062F\u06CC\u062F\u06CC \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F", useStore3.getState().chats.length === before);
console.log("3) \u062A\u06CC\u062A\u0631 \u062E\u0627\u0644\u06CC \u2192 \u067E\u06CC\u0634\u0641\u0631\u0636 \xAB\u0628\u062E\u0634\xBB:");
var srcMsg2 = useStore3.getState().chats.find((c) => c.id === srcId).messages.find((m) => m.role === "assistant");
useStore3.getState().forkSection(srcMsg2.id, "   ", "\u0645\u062A\u0646");
var newChat2 = useStore3.getState().chats.find((c) => c.id === useStore3.getState().activeChatId);
check("\u062A\u06CC\u062A\u0631 \u067E\u06CC\u0634\u0641\u0631\u0636 \xAB\u0628\u062E\u0634\xBB", newChat2.title === "\u0628\u062E\u0634", newChat2.title);
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
/*! Bundled license information:

react/cjs/react.production.js:
  (**
   * @license React
   * react.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react.development.js:
  (**
   * @license React
   * react.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

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
