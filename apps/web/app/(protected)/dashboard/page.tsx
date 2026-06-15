'use client'

import React from "react";

import TestComponent from "@web/components/dashboard";

import { useCreateTenant } from "@web/hooks/api/tentant";

export default function Dashboard() {
    const { createTenantAsync } = useCreateTenant();

    React.useEffect(() => {
        console.log("Creating tenant...");
        createTenantAsync().then((result) => {
            console.log("Tenant created:", result);
        }).catch((error) => {
            console.error("Error creating tenant:", error);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div>
            <TestComponent/>
        </div>
    );
}
