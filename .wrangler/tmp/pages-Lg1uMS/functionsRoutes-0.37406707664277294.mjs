import { onRequestPost as __api_sync_dashboard_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\api\\sync-dashboard.js"
import { onRequestGet as __google_calendar_callback_js_onRequestGet } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\google-calendar\\callback.js"
import { onRequestPost as __google_calendar_connect_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\google-calendar\\connect.js"
import { onRequestPost as __google_calendar_disconnect_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\google-calendar\\disconnect.js"
import { onRequestGet as __google_calendar_events_js_onRequestGet } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\google-calendar\\events.js"
import { onRequestGet as __google_calendar_status_js_onRequestGet } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\google-calendar\\status.js"
import { onRequestPost as __change_password_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\change-password.js"
import { onRequestPost as __create_user_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\create-user.js"
import { onRequestPost as __delete_user_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\delete-user.js"
import { onRequestGet as __list_users_js_onRequestGet } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\list-users.js"
import { onRequestPost as __mark_password_change_required_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\mark-password-change-required.js"
import { onRequestPost as __remove_account_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\remove-account.js"
import { onRequestPost as __user_settings_js_onRequestPost } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\user-settings.js"
import { onRequest as ___middleware_js_onRequest } from "C:\\Users\\Gienixx\\SL-CS-Knowledge-base\\functions\\_middleware.js"

export const routes = [
    {
      routePath: "/api/sync-dashboard",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_sync_dashboard_js_onRequestPost],
    },
  {
      routePath: "/google-calendar/callback",
      mountPath: "/google-calendar",
      method: "GET",
      middlewares: [],
      modules: [__google_calendar_callback_js_onRequestGet],
    },
  {
      routePath: "/google-calendar/connect",
      mountPath: "/google-calendar",
      method: "POST",
      middlewares: [],
      modules: [__google_calendar_connect_js_onRequestPost],
    },
  {
      routePath: "/google-calendar/disconnect",
      mountPath: "/google-calendar",
      method: "POST",
      middlewares: [],
      modules: [__google_calendar_disconnect_js_onRequestPost],
    },
  {
      routePath: "/google-calendar/events",
      mountPath: "/google-calendar",
      method: "GET",
      middlewares: [],
      modules: [__google_calendar_events_js_onRequestGet],
    },
  {
      routePath: "/google-calendar/status",
      mountPath: "/google-calendar",
      method: "GET",
      middlewares: [],
      modules: [__google_calendar_status_js_onRequestGet],
    },
  {
      routePath: "/change-password",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__change_password_js_onRequestPost],
    },
  {
      routePath: "/create-user",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__create_user_js_onRequestPost],
    },
  {
      routePath: "/delete-user",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__delete_user_js_onRequestPost],
    },
  {
      routePath: "/list-users",
      mountPath: "/",
      method: "GET",
      middlewares: [],
      modules: [__list_users_js_onRequestGet],
    },
  {
      routePath: "/mark-password-change-required",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__mark_password_change_required_js_onRequestPost],
    },
  {
      routePath: "/remove-account",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__remove_account_js_onRequestPost],
    },
  {
      routePath: "/user-settings",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__user_settings_js_onRequestPost],
    },
  {
      routePath: "/",
      mountPath: "/",
      method: "",
      middlewares: [___middleware_js_onRequest],
      modules: [],
    },
  ]