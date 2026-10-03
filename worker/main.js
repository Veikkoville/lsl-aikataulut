// Wranglerin pääsytetiedosto: vie vain oletuskäsittelijän (fetch + scheduled).
// worker.js vie lisäksi nimettyjä vakioita ja funktioita testeille (esim. LOGIN_MAX, isAllowedOrigin). Paikallinen
// workerd (wrangler dev) tulkitsee pääsytetiedoston jokaisen nimetyn viennin entrypointiksi ja kaatuu, jos vienti
// ei ole funktio tai käsittelijä ("Incorrect type for map entry"). Siksi pääsytetiedosto on erillinen.
export { default } from "./worker.js";
