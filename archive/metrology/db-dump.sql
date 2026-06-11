--
-- PostgreSQL database dump
--

\restrict tbrACFnR1LY2VqOrQwyFszFhm1R4yqt0VdDOrWF3bkDGGD2cOT2O2VXqlbt0z9d

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: metrology_calibrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrology_calibrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    performed_at date NOT NULL,
    valid_until date NOT NULL,
    certificate_number character varying(100),
    calibrator_org character varying(300),
    result public.metrology_calibration_result NOT NULL,
    notes text,
    document_attachment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT metrology_calibrations_valid_after_performed CHECK ((valid_until >= performed_at))
);

ALTER TABLE ONLY public.metrology_calibrations FORCE ROW LEVEL SECURITY;


--
-- Name: metrology_reminder_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrology_reminder_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    sent_on date NOT NULL,
    channel character varying(20) DEFAULT 'email'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.metrology_reminder_log FORCE ROW LEVEL SECURITY;


--
-- Name: metrology_si_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrology_si_details (
    asset_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    type_name character varying(200) NOT NULL,
    pattern_registry_number character varying(50),
    accuracy_class character varying(50),
    measurement_range character varying(200),
    calibration_interval_months smallint NOT NULL,
    last_calibration_at date,
    next_calibration_at date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT metrology_si_details_interval_positive CHECK ((calibration_interval_months > 0))
);

ALTER TABLE ONLY public.metrology_si_details FORCE ROW LEVEL SECURITY;


--
-- Data for Name: metrology_calibrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metrology_calibrations (id, tenant_id, asset_id, performed_at, valid_until, certificate_number, calibrator_org, result, notes, document_attachment_id, created_at, updated_at, deleted_at) FROM stdin;
\.


--
-- Data for Name: metrology_reminder_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metrology_reminder_log (id, tenant_id, user_id, sent_on, channel, created_at) FROM stdin;
\.


--
-- Data for Name: metrology_si_details; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metrology_si_details (asset_id, tenant_id, type_name, pattern_registry_number, accuracy_class, measurement_range, calibration_interval_months, last_calibration_at, next_calibration_at, created_at, updated_at, deleted_at) FROM stdin;
\.


--
-- Name: metrology_calibrations metrology_calibrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_calibrations
    ADD CONSTRAINT metrology_calibrations_pkey PRIMARY KEY (id);


--
-- Name: metrology_reminder_log metrology_reminder_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_reminder_log
    ADD CONSTRAINT metrology_reminder_log_pkey PRIMARY KEY (id);


--
-- Name: metrology_reminder_log metrology_reminder_log_unique_per_day; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_reminder_log
    ADD CONSTRAINT metrology_reminder_log_unique_per_day UNIQUE (tenant_id, user_id, sent_on, channel);


--
-- Name: metrology_si_details metrology_si_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_si_details
    ADD CONSTRAINT metrology_si_details_pkey PRIMARY KEY (asset_id);


--
-- Name: metrology_calibrations_tenant_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrology_calibrations_tenant_asset_idx ON public.metrology_calibrations USING btree (tenant_id, asset_id, performed_at DESC);


--
-- Name: metrology_reminder_log_tenant_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrology_reminder_log_tenant_sent_idx ON public.metrology_reminder_log USING btree (tenant_id, sent_on);


--
-- Name: metrology_si_details_tenant_next_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrology_si_details_tenant_next_idx ON public.metrology_si_details USING btree (tenant_id, next_calibration_at);


--
-- Name: metrology_calibrations metrology_calibrations_asset_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_calibrations
    ADD CONSTRAINT metrology_calibrations_asset_id_fk FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE CASCADE;


--
-- Name: metrology_reminder_log metrology_reminder_log_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_reminder_log
    ADD CONSTRAINT metrology_reminder_log_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: metrology_si_details metrology_si_details_asset_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrology_si_details
    ADD CONSTRAINT metrology_si_details_asset_id_fk FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE CASCADE;


--
-- Name: metrology_calibrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.metrology_calibrations ENABLE ROW LEVEL SECURITY;

--
-- Name: metrology_reminder_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.metrology_reminder_log ENABLE ROW LEVEL SECURITY;

--
-- Name: metrology_si_details; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.metrology_si_details ENABLE ROW LEVEL SECURITY;

--
-- Name: metrology_calibrations tenant_isolation_metrology_calibrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_metrology_calibrations ON public.metrology_calibrations USING ((tenant_id = public.current_tenant_id()));


--
-- Name: metrology_reminder_log tenant_isolation_metrology_reminder_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_metrology_reminder_log ON public.metrology_reminder_log USING ((tenant_id = public.current_tenant_id()));


--
-- Name: metrology_si_details tenant_isolation_metrology_si_details; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_metrology_si_details ON public.metrology_si_details USING ((tenant_id = public.current_tenant_id()));


--
-- Name: TABLE metrology_calibrations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.metrology_calibrations TO app_runtime;


--
-- Name: TABLE metrology_reminder_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.metrology_reminder_log TO app_runtime;


--
-- Name: TABLE metrology_si_details; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.metrology_si_details TO app_runtime;


--
-- PostgreSQL database dump complete
--

\unrestrict tbrACFnR1LY2VqOrQwyFszFhm1R4yqt0VdDOrWF3bkDGGD2cOT2O2VXqlbt0z9d

