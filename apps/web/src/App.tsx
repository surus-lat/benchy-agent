import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/auth-gate";
import Landing from "@/pages/landing";
import Login from "@/pages/login";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

// Public: the landing (with Request Access) and the sign-in page. The invite
// email links to /accept-invite, which is the sign-in page with the address
// prefilled. Everything under /app requires a session and an org.
function GatedApp() {
  return (
    <AuthGate>
      <Home />
    </AuthGate>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/accept-invite" component={Login} />
      <Route path="/app" component={GatedApp} />
      <Route path="/app/:rest*" component={GatedApp} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
